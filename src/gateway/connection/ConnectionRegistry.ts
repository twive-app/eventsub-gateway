import type {ServerWebSocket} from "bun";
import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {
    GatewayCloseCode,
    GatewayOpCode,
    GatewayProtocol,
    type GatewayInvalidSessionData,
    type GatewayPayload,
} from "@gateway/GatewayProtocol.ts";
import type {ConnectionRef, ConnectionState, ConnectionStore} from "@gateway/connection/ConnectionStore.ts";

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

/** A socket of this instance with its session, delivery, heartbeat and rate limit state – all in memory. */
export interface LocalConnection extends ConnectionRef {
    socket: ServerWebSocket<SocketData>;
    sequence: number;
    delivery: Promise<void>;
    // Deliveries still queued in `delivery` – 0 lets the next event go out right away.
    pendingDeliveries: number;
    backlog: number;
    // Set on IDENTIFY/RESUME and on every HEARTBEAT; the timeout check reads only this, never Redis.
    lastHeartbeatAt: number;
    // While IDENTIFY/RESUME runs the identify timeout doesn't apply – setting up a large app may take longer.
    authenticating: boolean;
    rateLimitCount: number;
    rateLimitWindowEndsAt: number;
}

/** The open sockets of this instance – sending, closing and the timeouts of HELLO and HEARTBEAT. */
@Bean()
export class ConnectionRegistry {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private connectionStore!: ConnectionStore;

    private readonly connections: Map<string, LocalConnection> = new Map<string, LocalConnection>();

    /** RECONNECT to every identified connection of an app, then 4012 – the clients RESUME, their sessions stay. */
    public reconnectApp(clientId: string, reason: string): number {
        let count: number = 0;
        for (const connection of this.connections.values()) {
            if (connection.clientId !== clientId || !connection.sessionId) continue;

            this.send(connection, GatewayProtocol.createPayload(GatewayOpCode.Reconnect));
            this.close(connection, GatewayCloseCode.ReconnectRequested, reason);
            count++;
        }
        return count;
    }

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
            pendingDeliveries: 0,
            backlog: 0,
            lastHeartbeatAt: Date.now(),
            authenticating: false,
            rateLimitCount: 0,
            rateLimitWindowEndsAt: 0,
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

    /** Sends a payload or an already serialized frame; a client that reads too slowly is closed with 4000 before it misses more than it can RESUME. */
    public send(connection: LocalConnection, payload: GatewayPayload | string): boolean {
        if (!this.isOpen(connection)) return false;

        const status: number = connection.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        if (status > 0) {
            connection.backlog = 0;
            return true;
        }
        // Negative status = buffered by Bun because the client doesn't read fast enough.
        if (status < 0 && ++connection.backlog <= this.maxBacklog()) return true;

        this.logger.warn("CONNECTION", "Client reads too slowly, closing (4000)", {
            id: connection.connectionId,
            app: connection.clientId,
            buffered: connection.backlog,
        });
        this.close(connection, GatewayCloseCode.UnknownError, "Client too slow, RESUME");
        return false;
    }

    /** Closes the socket if it is still open. */
    public close(connection: LocalConnection, code: number, reason: string): void {
        if (this.isOpen(connection)) connection.socket.close(code, ConnectionRegistry.closeReason(reason));
    }

    /** A close reason may have at most 123 bytes (RFC 6455) – longer ones (e.g. with client input) are cut. */
    public static closeReason(reason: string): string {
        if (Buffer.byteLength(reason) <= 123) return reason;

        let cut: string = reason;
        while (Buffer.byteLength(`${cut}…`) > 123) cut = cut.slice(0, -1);
        return `${cut}…`;
    }

    /** Sends INVALID_SESSION – the connection stays open so the client can IDENTIFY again. */
    public sendInvalidSession(connection: LocalConnection, resumable: boolean, message: string): void {
        this.send(connection, GatewayProtocol.createPayload<GatewayInvalidSessionData>(GatewayOpCode.InvalidSession, {
            resumable,
            message,
        }));
    }

    /** Whether the socket is still open. */
    public isOpen(connection: LocalConnection): boolean {
        return connection.socket.readyState === webSocketOpen;
    }

    /** Counts a client message in its fixed window (starting with the first message); false once the limit is exceeded. */
    public consumeRateLimit(connection: LocalConnection, maxMessages: number, windowMs: number): boolean {
        const now: number = Date.now();
        if (now >= connection.rateLimitWindowEndsAt) {
            connection.rateLimitWindowEndsAt = now + windowMs;
            connection.rateLimitCount = 0;
        }
        return ++connection.rateLimitCount <= maxMessages;
    }

    /** Every 5 s: closes connections without IDENTIFY/RESUME in time (4003) or without heartbeat (4008). */
    @Cron("*/5 * * * * *")
    public async checkTimeouts(): Promise<void> {
        const timeout: number = this.configManager.get().gateway.heartbeatInterval * heartbeatToleranceFactor;
        const now: number = Date.now();
        const pending: ConnectionRef[] = [];

        // Identified connections: heartbeats are tracked in memory – no Redis read per connection.
        for (const connection of this.connections.values()) {
            if (!connection.clientId) {
                if (!connection.authenticating) pending.push({
                    connectionId: connection.connectionId,
                    clientId: null,
                    sessionId: null,
                });
                continue;
            }
            if (now - connection.lastHeartbeatAt <= timeout) continue;

            this.logger.info("CONNECTION", "Heartbeat missed, closing (4008)", {
                id: connection.connectionId,
                app: connection.clientId,
                session: connection.sessionId,
            });
            this.close(connection, GatewayCloseCode.HeartbeatTimeout, "Heartbeat timed out");
        }

        if (pending.length === 0) return;

        // Pending connections: their Redis entry expires with the identify timeout (and is renewed after a failed attempt).
        let states: ConnectionState[];
        try {
            states = await this.connectionStore.getStates(pending);
        } catch (error) {
            return this.logger.warnThrottled("CONNECTION", "Could not check the identify timeouts", undefined, error);
        }

        pending.forEach((ref: ConnectionRef, index: number): void => {
            const connection: LocalConnection | undefined = this.get(ref.connectionId);
            const state: ConnectionState = states[index];
            // Skip connections that closed, identified or started IDENTIFY/RESUME while Redis was read, and those still in time.
            if (!connection || connection.clientId || connection.authenticating || state.status !== "pending" || state.exists) return;

            const seconds: number = this.configManager.get().gateway.identifyTimeout / 1000;
            this.logger.debug("CONNECTION", "No IDENTIFY/RESUME in time, closing (4003)", {
                id: ref.connectionId,
            });
            this.close(connection, GatewayCloseCode.NotAuthenticated, `You must IDENTIFY or RESUME within ${seconds} seconds`);
        });
    }

    /** Frames that may queue up for a slow client – half the replay buffer, so RESUME still has them. */
    private maxBacklog(): number {
        const replayBufferSize: number = this.configManager.get().gateway.replayBufferSize;
        return replayBufferSize > 0 ? Math.floor(replayBufferSize / 2) : Number.POSITIVE_INFINITY;
    }
}
