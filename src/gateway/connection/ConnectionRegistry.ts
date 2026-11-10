import type {ServerWebSocket} from "bun";
import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {
    GatewayCloseCode,
    GatewayOpCode,
    GatewayProtocol,
    type GatewayInvalidSessionData,
    type GatewayPayload,
} from "@gateway/GatewayProtocol.ts";
import type {ConnectionRef, ConnectionState, ConnectionStore} from "@gateway/connection/ConnectionStore.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";

const webSocketOpen: number = 1;
// A connection may miss half a heartbeat interval before it is closed.
const heartbeatToleranceFactor: number = 1.5;

/** Data attached to every socket at the upgrade. */
export interface SocketData {
    connectionId: string;
    remoteAddress: string;
    socketAddress: string;
    rejection: {code: GatewayCloseCode; reason: string} | null;
}

/** A socket of this instance with its session and delivery state. */
export interface LocalConnection extends ConnectionRef {
    socket: ServerWebSocket<SocketData>;
    sequence: number;
    delivery: Promise<void>;
    backlog: number;
}

/** The open sockets of this instance – sending, closing and the timeouts of HELLO and HEARTBEAT. */
@Bean()
export class ConnectionRegistry {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    @Autowired()
    private connectionStore!: ConnectionStore;

    @Autowired()
    private sessionStore!: SessionStore;

    private readonly connections: Map<string, LocalConnection> = new Map<string, LocalConnection>();

    /** Closes a connection whose session was resumed elsewhere (4011) without touching that session. */
    public replaceSession(connection: LocalConnection): void {
        connection.sessionId = null;
        this.close(connection, GatewayCloseCode.SessionReplaced, "Session was resumed on another connection");
    }

    /** Registers a newly opened socket. */
    public add(socket: ServerWebSocket<SocketData>): LocalConnection {
        const connection: LocalConnection = {
            socket,
            connectionId: socket.data.connectionId,
            clientId: null,
            sessionId: null,
            sequence: 0,
            delivery: Promise.resolve(),
            backlog: 0,
        };
        this.connections.set(connection.connectionId, connection);
        return connection;
    }

    /** The connection with this id, if it is open on this instance. */
    public get(connectionId: string): LocalConnection | undefined {
        return this.connections.get(connectionId);
    }

    /** Forgets a closed connection. */
    public delete(connectionId: string): void {
        this.connections.delete(connectionId);
    }

    /** All open connections. */
    public all(): LocalConnection[] {
        return [...this.connections.values()];
    }

    /** All open connections, and forgets them (shutdown). */
    public takeAll(): LocalConnection[] {
        const connections: LocalConnection[] = this.all();
        this.connections.clear();
        return connections;
    }

    /** Number of open connections (for /health). */
    public size(): number {
        return this.connections.size;
    }

    /** Sends a frame; a client that reads too slowly is closed with 4000 before it misses more than it can RESUME. */
    public send(connection: LocalConnection, payload: GatewayPayload): boolean {
        if (!this.isOpen(connection)) return false;

        const status: number = connection.socket.send(JSON.stringify(payload));
        if (status > 0) {
            connection.backlog = 0;
            return true;
        }
        // Negative status = buffered by Bun because the client doesn't read fast enough.
        if (status < 0 && ++connection.backlog <= this.maxBacklog()) return true;

        this.logger.warning("CONNECTION", `Connection ${connection.connectionId} can't keep up (${connection.backlog} frames buffered), closing it`);
        this.close(connection, GatewayCloseCode.UnknownError, "Client too slow, RESUME");
        return false;
    }

    /** Frames that may queue up for a slow client – half the replay buffer, so RESUME still has them. */
    private maxBacklog(): number {
        const replayBufferSize: number = this.configManager.get().gateway.replayBufferSize;
        return replayBufferSize > 0 ? Math.floor(replayBufferSize / 2) : Number.POSITIVE_INFINITY;
    }

    /** Closes the socket if it is still open. */
    public close(connection: LocalConnection, code: number, reason: string): void {
        if (this.isOpen(connection)) connection.socket.close(code, reason);
    }

    /** Sends INVALID_SESSION – the connection stays open so the client can IDENTIFY again. */
    public sendInvalidSession(connection: LocalConnection, resumable: boolean, message: string): void {
        this.send(connection, GatewayProtocol.createPayload<GatewayInvalidSessionData>(GatewayOpCode.InvalidSession, {resumable, message}));
    }

    /** Whether the socket is still open. */
    public isOpen(connection: LocalConnection): boolean {
        return connection.socket.readyState === webSocketOpen;
    }

    /** Removes a closed connection from Redis and ends or detaches its session, depending on the close code. */
    public async cleanUp(ref: ConnectionRef, code: number | null): Promise<void> {
        await this.connectionStore.remove(ref);
        if (!ref.clientId || !ref.sessionId) return;

        if (code !== null && GatewayProtocol.sessionInvalidatingCloseCodes.has(code)) {
            await this.sessionStore.destroyOwned(ref.clientId, ref.sessionId, ref.connectionId);
        } else {
            await this.sessionStore.detach(ref.clientId, ref.sessionId, ref.connectionId);
        }
    }

    /** Every 5 s: closes connections without IDENTIFY/RESUME in time (4003) or without heartbeat (4008). */
    @Cron("*/5 * * * * *")
    public async checkTimeouts(): Promise<void> {
        const refs: ConnectionRef[] = this.all().map((connection: LocalConnection): ConnectionRef => ({
            connectionId: connection.connectionId,
            clientId: connection.clientId,
            sessionId: connection.sessionId,
        }));

        let states: ConnectionState[];
        try {
            states = await this.connectionStore.getStates(refs);
        } catch (error) {
            return this.errorReporter.handleThrottled("CONNECTION", "Could not check gateway timeouts", error);
        }

        const timeout: number = this.configManager.get().gateway.heartbeatInterval * heartbeatToleranceFactor;
        const now: number = Date.now();

        refs.forEach((ref: ConnectionRef, index: number): void => {
            const connection: LocalConnection | undefined = this.get(ref.connectionId);
            // Skip connections that closed or identified while Redis was read.
            if (!connection || connection.clientId !== ref.clientId) return;

            const state: ConnectionState = states[index];
            if (state.status === "pending") {
                // The pending entry still exists, the identify timeout hasn't passed yet.
                if (state.exists) return;

                const seconds: number = this.configManager.get().gateway.identifyTimeout / 1000;
                this.logger.debug("CONNECTION", `Connection ${ref.connectionId} did not identify in time`);
                return this.close(connection, GatewayCloseCode.NotAuthenticated, `You must IDENTIFY or RESUME within ${seconds} seconds`);
            }

            if (state.connection && now - state.connection.lastHeartbeatAt <= timeout) return;

            this.logger.warning("CONNECTION", `Connection ${ref.connectionId} missed its heartbeat. Closing.`);
            this.close(connection, GatewayCloseCode.HeartbeatTimeout, "Heartbeat timed out");
        });
    }
}
