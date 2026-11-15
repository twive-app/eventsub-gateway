import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {GatewayProtocol, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import type {ConnectionRegistry, LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import type {DispatchTarget, SessionStore} from "@gateway/session/SessionStore.ts";

/** Sends events to the sessions of an app – exactly once and in order per connection. */
@Bean()
export class SessionDispatcher {
    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    /** Dispatches an event to every session of an app; sessions without a live connection only buffer it. */
    public dispatch(appClientId: string, eventName: string, data: unknown): void {
        // Serialized once – each connection only gets its own sequence number spliced in.
        const dataJson: string = JSON.stringify(data ?? null);

        this.sessionStore.dispatch(appClientId, eventName, dataJson).then((targets: DispatchTarget[]): void => {
            let live: number = 0;
            for (const target of targets) {
                const connection: LocalConnection | undefined = this.connectionRegistry.get(target.connectionId);
                // A detached session (waiting for RESUME) gets the event from the replay buffer later.
                if (!connection) continue;

                this.deliver(connection, appClientId, target.sessionId, target.sequence, GatewayProtocol.serializeDispatch(eventName, dataJson, target.sequence));
                live++;
            }

            if (targets.length > 0) {
                this.logger.debug("DISPATCH", `Dispatched ${eventName} to ${targets.length} session(s) of app ${appClientId} (${live} live)`);
            }
        }).catch((error: unknown): void => {
            this.errorReporter.handleThrottled("DISPATCH", `Could not dispatch ${eventName} to app ${appClientId}`, error);
        });
    }

    /** Sends one frame to a connection, queued per connection so sequenced events never overtake each other. */
    private deliver(connection: LocalConnection, clientId: string, sessionId: string, sequence: number | null, frame: string): void {
        if (sequence === null) {
            if (connection.sessionId === sessionId) this.connectionRegistry.send(connection, frame);
            return;
        }

        // The usual case – the next number and nothing queued: send right away, without a promise per event.
        if (connection.pendingDeliveries === 0 && connection.sessionId === sessionId && sequence === connection.sequence + 1) {
            this.sendSequenced(connection, sequence, frame);
            return;
        }

        connection.pendingDeliveries++;
        connection.delivery = connection.delivery.then(async (): Promise<void> => {
            // The session moved on (RESUME elsewhere) or this event was already sent (e.g. with the replay).
            if (connection.sessionId !== sessionId || sequence <= connection.sequence) return;

            // A gap: an event was dispatched while a RESUME attached the session – fill it from the buffer first.
            if (sequence > connection.sequence + 1) {
                const missed: GatewayPayload[] = await this.sessionStore.getBuffered(clientId, sessionId, connection.sequence, sequence);
                if (connection.sessionId !== sessionId) return;
                for (const buffered of missed) this.sendSequenced(connection, buffered.s ?? 0, buffered);
            }

            this.sendSequenced(connection, sequence, frame);
        }).catch((error: unknown): void => {
            this.errorReporter.handleThrottled("DISPATCH", `Could not deliver an event to connection ${connection.connectionId}`, error);
        }).finally((): void => {
            connection.pendingDeliveries--;
        });
    }

    /** Sends a sequenced frame if it is newer than the last one, and remembers its number. */
    private sendSequenced(connection: LocalConnection, sequence: number, frame: GatewayPayload | string): void {
        if (sequence > connection.sequence && this.connectionRegistry.send(connection, frame)) connection.sequence = sequence;
    }
}
