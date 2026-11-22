import crypto from "node:crypto";
import type {Server, ServerWebSocket} from "bun";
import type {ZodSafeParseResult} from "zod";
import {Autowired, Bean, HealthCheck, PostConstruct, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import type {HealthCheckResult} from "@core/bean/BeanManager.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import {MainError} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import type {ProxyService, RemoteAddress} from "@core/proxy/ProxyService.ts";
import {GatewayBeanDecorators, type GatewayOpCodeResult} from "@gateway/GatewayBeanDecorators.ts";
import {
    gatewayBasePayloadSchema,
    GatewayCloseCode,
    GatewayOpCode,
    GatewayProtocol,
    type GatewayBasePayload,
    type GatewayHelloData,
} from "@gateway/GatewayProtocol.ts";
import type {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import type {ConnectionRegistry, LocalConnection, SocketData} from "@gateway/connection/ConnectionRegistry.ts";
import type {ConnectionStore} from "@gateway/connection/ConnectionStore.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";

// Close codes counted by their number – a client may close with any code, the rest is "other".
const countedCloseCodes: Set<number> = new Set<number>([1000, 1001, 1005, 1006, 1011, 1012, ...Object.values(GatewayCloseCode)
    .filter((code: string | number): code is number => typeof code === "number")],
);

// Upgrade requests carry nobody; WebSocket messages are limited by GATEWAY_MAX_PAYLOAD_SIZE.
const maxRequestBodySize: number = 1024;

/** The WebSocket server: accepts connections, validates every client message and routes it by opcode. */
@Bean()
export class GatewayServer {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    @Autowired()
    private proxyService!: ProxyService;

    @Autowired()
    private connectionLimitManager!: ConnectionLimitManager;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    @Autowired()
    private connectionStore!: ConnectionStore;

    @Autowired()
    private sessionStore!: SessionStore;

    private server: Server<SocketData> | null = null;
    private readonly closeWaiters: Map<string, () => void> = new Map<string, () => void>();

    /** Starts the WebSocket server; a port that is in use stops the startup. */
    @PostConstruct()
    public initialize(): void {
        const config: ConfigValues["gateway"] = this.configManager.get().gateway;

        try {
            this.server = Bun.serve({
                hostname: config.host,
                port: config.port,
                maxRequestBodySize,
                fetch: (request: Request, server: Server<SocketData>): Response | undefined => {
                    const {address, socketAddress}: RemoteAddress = this.proxyService.resolve(request, server);
                    const data: SocketData = {
                        connectionId: crypto.randomUUID(),
                        remoteAddress: address,
                        socketAddress,
                        // An unsupported v or an exceeded connection limit is rejected right after the upgrade.
                        rejection: this.getRejection(request) ?? this.connectionLimitManager.acquire(address),
                    };
                    if (server.upgrade(request, {data})) return undefined;

                    // The upgrade failed (no WebSocket request) – give the reserved connection slot back.
                    if (data.rejection === null) this.connectionLimitManager.release(address);
                    return new Response("Upgrade Required", {
                        status: 426,
                    });
                },
                websocket: {
                    data: {} as SocketData,
                    maxPayloadLength: config.maxPayloadSize,
                    perMessageDeflate: false,
                    idleTimeout: 0,
                    open: (socket: ServerWebSocket<SocketData>): void => this.handleConnection(socket),
                    message: (socket: ServerWebSocket<SocketData>, message: string | Buffer): void => {
                        const connection: LocalConnection | undefined = this.connectionRegistry.get(socket.data.connectionId);
                        if (!connection) return;

                        this.handleMessage(connection, String(message)).catch((error: unknown): void => {
                            this.logger.error("GATEWAY", "Could not handle a client message", {
                                app: connection.clientId,
                                conn: connection.connectionId,
                            }, error);
                            this.connectionRegistry.close(connection, GatewayCloseCode.UnknownError, "Unknown error");
                        });
                    },
                    close: (socket: ServerWebSocket<SocketData>, code: number): void => {
                        if (socket.data.rejection === null) this.connectionLimitManager.release(socket.data.remoteAddress);
                        this.closeWaiters.get(socket.data.connectionId)?.();
                        this.handleClose(socket.data.connectionId, code).catch((error: unknown): void => {
                            this.logger.warnThrottled("CONNECTION", "Could not clean up a closed connection", {
                                id: socket.data.connectionId,
                            }, error);
                        });
                    },
                },
            });
            this.logger.success("GATEWAY", "Listening (WebSocket)", {
                port: config.port,
                protocol: `v${GatewayProtocol.version}`,
            });
        } catch (error) {
            // The startup stops (see @MainClass) – with the shutdown hooks, so nothing stays open.
            this.logger.error("GATEWAY", "Could not start the WebSocket server", {
                port: config.port,
            }, error);
            throw new MainError("STARTUP_FAILED", "The WebSocket server could not start");
        }
    }

    /** GET /health: whether the WebSocket server is running. */
    @HealthCheck("gateway")
    public checkHealth(): HealthCheckResult {
        return {
            ok: this.server !== null,
            failure: "gateway not listening",
        };
    }

    /** On shutdown: detach every session, send RECONNECT and close with 1012 so clients RESUME after the restart. */
    @ShutdownHook(10)
    public async closeConnections(): Promise<void> {
        const connections: LocalConnection[] = this.connectionRegistry.takeAll();
        this.logger.info("GATEWAY", "Closing client connections", {
            count: connections.length,
        });

        try {
            await this.sessionStore.endConnections(connections);
        } catch (error) {
            this.logger.warn("SESSION", "Could not detach all sessions, they expire with their TTL", undefined, error);
        }

        const closed: Promise<void>[] = connections.map((connection: LocalConnection): Promise<void> => {
            return new Promise<void>((resolve: () => void): void => {
                this.closeWaiters.set(connection.connectionId, resolve);
                this.connectionRegistry.send(connection, GatewayProtocol.createPayload(GatewayOpCode.Reconnect));
                this.connectionRegistry.close(connection, 1012, "Gateway is restarting, please resume");
            });
        });

        // Wait at most 2 s for the clients to close.
        await Promise.race([
            Promise.allSettled(closed),
            Bun.sleep(2000),
        ]);

        await this.server?.stop(true);
        this.server = null;
    }

    /** A new socket: rejects it or registers it and sends HELLO. */
    private handleConnection(socket: ServerWebSocket<SocketData>): void {
        const {connectionId, remoteAddress, socketAddress, rejection}: SocketData = socket.data;
        const from: string = remoteAddress === socketAddress ? remoteAddress : `${remoteAddress} via ${socketAddress}`;

        // Rejected before HELLO: no registry entry, no Redis key.
        if (rejection) {
            this.metricsRegistry.increment("connections_rejected", "WebSocket connections rejected right after the upgrade, by close code", {
                code: String(rejection.code),
            });
            this.logger.info("CONNECTION", `Rejected (${rejection.code}): ${rejection.reason}`, {
                ip: from,
            });
            return socket.close(rejection.code, rejection.reason);
        }

        const connection: LocalConnection = this.connectionRegistry.add(socket);
        this.metricsRegistry.increment("connections_opened", "WebSocket connections opened");
        this.logger.info("CONNECTION", "Opened", {
            id: connectionId,
            ip: from,
        });

        this.connectionStore.createPending(connectionId, remoteAddress).then((): void => {
            this.connectionRegistry.send(connection, GatewayProtocol.createPayload<GatewayHelloData>(GatewayOpCode.Hello, {
                heartbeatInterval: this.configManager.get().gateway.heartbeatInterval,
            }));
        }).catch((error: unknown): void => {
            this.logger.warnThrottled("CONNECTION", "Could not register a new connection", {
                id: connectionId,
            }, error);
            this.connectionRegistry.close(connection, GatewayCloseCode.UnknownError, "Service temporarily unavailable, try again later");
        });
    }

    /** One client message: rate limit, JSON, payload shape, then the @OpCode method of its opcode (GatewayHandler). */
    private async handleMessage(connection: LocalConnection, rawData: string): Promise<void> {
        // In memory – a connection lives only on this instance, so no Redis round trip per message.
        const {maxMessages, windowMs}: ConfigValues["gateway"]["rateLimit"] = this.configManager.get().gateway.rateLimit;
        if (!this.connectionRegistry.consumeRateLimit(connection, maxMessages, windowMs)) return this.connectionRegistry.close(connection, GatewayCloseCode.RateLimited, "You are sending too many payloads");

        let json: unknown;
        try {
            json = JSON.parse(rawData);
        } catch {
            return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid JSON");
        }

        const base: ZodSafeParseResult<GatewayBasePayload> = gatewayBasePayloadSchema.safeParse(json);
        if (!base.success) return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid payload");

        const result: GatewayOpCodeResult = await GatewayBeanDecorators.route(connection, base.data.op, base.data.d);
        if (result === "unknown") return this.connectionRegistry.close(connection, GatewayCloseCode.UnknownOpCode, `Unknown opcode ${base.data.op}`);
        if (result === "invalid") return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, `Invalid ${GatewayBeanDecorators.nameOf(base.data.op)} payload`);
    }

    /** A closed socket: forget it locally, then detach or destroy its session depending on the close code. */
    private async handleClose(connectionId: string, code: number): Promise<void> {
        this.closeWaiters.delete(connectionId);

        const connection: LocalConnection | undefined = this.connectionRegistry.get(connectionId);
        if (!connection) return;

        this.connectionRegistry.delete(connectionId);
        this.metricsRegistry.increment("connections_closed", "WebSocket connections closed, by close code", {
            code: countedCloseCodes.has(code) ? String(code) : "other",
        });

        if (connection.sessionId) {
            const invalidated: boolean = GatewayProtocol.sessionInvalidatingCloseCodes.has(code);
            this.logger.info("SESSION", invalidated ? `Closed (${code})` : `Disconnected (${code}), resumable`, {
                id: connection.sessionId,
                app: connection.clientId,
                conn: connectionId,
            });
        }

        await this.sessionStore.endConnection(connection, GatewayProtocol.sessionInvalidatingCloseCodes.has(code));
    }

    /** Close code and reason if the requested version (query v) is not supported, otherwise null. */
    private getRejection(request: Request): SocketData["rejection"] {
        const version: string | null = new URL(request.url).searchParams.get("v");

        if (version !== null && version !== String(GatewayProtocol.version)) {
            return {
                code: GatewayCloseCode.InvalidApiVersion,
                reason: `Unsupported gateway version ${version}`,
            };
        }
        return null;
    }
}
