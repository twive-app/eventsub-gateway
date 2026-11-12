import crypto from "node:crypto";
import type {Server, ServerWebSocket} from "bun";
import type {ZodSafeParseResult} from "zod";
import {Autowired, Bean, PostConstruct, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {HttpProxyService, HttpRemoteAddress} from "@core/http/HttpProxyService.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {
    gatewayBasePayloadSchema,
    GatewayCloseCode,
    gatewayHeartbeatSchema,
    gatewayIdentifySchema,
    GatewayOpCode,
    GatewayProtocol,
    gatewayResumeSchema,
    type GatewayBasePayload,
    type GatewayHeartbeatData,
    type GatewayHelloData,
    type GatewayIdentifyData,
    type GatewayResumeData,
} from "@gateway/GatewayProtocol.ts";
import type {GatewayHandler} from "@gateway/GatewayHandler.ts";
import type {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import type {ConnectionRegistry, LocalConnection, SocketData} from "@gateway/connection/ConnectionRegistry.ts";
import type {ConnectionStore} from "@gateway/connection/ConnectionStore.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";

// Upgrade requests carry nobody; WebSocket messages are limited by GATEWAY_MAX_PAYLOAD_SIZE.
const maxRequestBodySize: number = 1024;

/** The WebSocket server: accepts connections, validates every client message and routes it by opcode. */
@Bean()
export class GatewayServer {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private errorReporter!: ErrorReporter;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private httpProxyService!: HttpProxyService;

    @Autowired()
    private connectionLimitManager!: ConnectionLimitManager;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    @Autowired()
    private connectionStore!: ConnectionStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private gatewayHandler!: GatewayHandler;

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
                    const {address, socketAddress}: HttpRemoteAddress = this.httpProxyService.resolve(request, server);
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
                    return new Response("Upgrade Required", {status: 426});
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
                            this.logger.error("GATEWAY", "Failed handling payload");
                            this.errorReporter.handle(error, {connectionId: connection.connectionId});
                            this.connectionRegistry.close(connection, GatewayCloseCode.UnknownError, "Unknown error");
                        });
                    },
                    close: (socket: ServerWebSocket<SocketData>, code: number): void => {
                        if (socket.data.rejection === null) this.connectionLimitManager.release(socket.data.remoteAddress);
                        this.closeWaiters.get(socket.data.connectionId)?.();
                        this.handleClose(socket.data.connectionId, code).catch((error: unknown): void => {
                            this.errorReporter.handleThrottled("CONNECTION", `Could not clean up connection ${socket.data.connectionId}`, error);
                        });
                    },
                },
            });
            this.logger.success("GATEWAY", `Ready on port ${config.port} (v${GatewayProtocol.version})`);
        } catch (error) {
            this.logger.error("GATEWAY", `Failed to start the gateway on port ${config.port}`);
            this.errorReporter.handle(error);
            process.exit(1);
        }
    }

    /** Whether the WebSocket server is running (for /health). */
    public isListening(): boolean {
        return this.server !== null;
    }

    /** On shutdown: detach every session, send RECONNECT and close with 1012 so clients RESUME after the restart. */
    @ShutdownHook(10)
    public async closeConnections(): Promise<void> {
        const connections: LocalConnection[] = this.connectionRegistry.takeAll();
        this.logger.info("GATEWAY", `Closing ${connections.length} client connection(s)`);

        try {
            await Promise.all(connections.map(async (connection: LocalConnection): Promise<void> => {
                if (connection.clientId && connection.sessionId) {
                    await this.sessionStore.detach(connection.clientId, connection.sessionId, connection.connectionId);
                }
            }));
            await this.connectionStore.removeAll(connections);
        } catch (error) {
            this.logger.warning("SESSION", "Could not detach all sessions, they expire with their TTL");
            this.errorReporter.handle(error);
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

        // Rejected before HELLO: no registry entry, no Redis key
        if (rejection) {
            this.logger.debug("CONNECTION", `Connection from ${from} rejected (${rejection.code} ${rejection.reason})`);
            return socket.close(rejection.code, rejection.reason);
        }

        const connection: LocalConnection = this.connectionRegistry.add(socket);
        this.logger.debug("CONNECTION", `New connection ${connectionId} from ${from}`);

        this.connectionStore.createPending(connectionId, remoteAddress).then((): void => {
            this.connectionRegistry.send(connection, GatewayProtocol.createPayload<GatewayHelloData>(GatewayOpCode.Hello, {
                heartbeatInterval: this.configManager.get().gateway.heartbeatInterval,
            }));
        }).catch((error: unknown): void => {
            this.errorReporter.handleThrottled("CONNECTION", "Could not register a new gateway connection", error);
            this.connectionRegistry.close(connection, GatewayCloseCode.UnknownError, "Service temporarily unavailable, try again later");
        });
    }

    /** One client message: rate limit, JSON, payload schema, then the handler of its opcode. */
    private async handleMessage(connection: LocalConnection, rawData: string): Promise<void> {
        const {maxMessages, windowMs}: ConfigValues["gateway"]["rateLimit"] = this.configManager.get().gateway.rateLimit;
        let allowed: boolean = true;
        try {
            allowed = await this.connectionStore.consumeRateLimit(connection.connectionId, maxMessages, windowMs);
        } catch (error) {
            this.errorReporter.handleThrottled("CONNECTION", "Could not check the gateway rate limit", error);
        }
        if (!allowed) return this.connectionRegistry.close(connection, GatewayCloseCode.RateLimited, "You are sending too many payloads");

        let json: unknown;
        try {
            json = JSON.parse(rawData);
        } catch {
            return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid JSON");
        }

        const base: ZodSafeParseResult<GatewayBasePayload> = gatewayBasePayloadSchema.safeParse(json);
        if (!base.success) return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid payload");

        switch (base.data.op) {
            case GatewayOpCode.Heartbeat: {
                const parsed: ZodSafeParseResult<GatewayHeartbeatData> = gatewayHeartbeatSchema.safeParse(base.data.d);
                if (!parsed.success) return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid HEARTBEAT payload");
                return this.gatewayHandler.heartbeat(connection);
            }

            case GatewayOpCode.Identify: {
                const parsed: ZodSafeParseResult<GatewayIdentifyData> = gatewayIdentifySchema.safeParse(base.data.d);
                if (!parsed.success) return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid IDENTIFY payload");
                return await this.gatewayHandler.identify(connection, parsed.data);
            }

            case GatewayOpCode.Resume: {
                const parsed: ZodSafeParseResult<GatewayResumeData> = gatewayResumeSchema.safeParse(base.data.d);
                if (!parsed.success) return this.connectionRegistry.close(connection, GatewayCloseCode.DecodeError, "Invalid RESUME payload");
                return await this.gatewayHandler.resume(connection, parsed.data);
            }

            default:
                return this.connectionRegistry.close(connection, GatewayCloseCode.UnknownOpCode, `Unknown opcode ${base.data.op}`);
        }
    }

    /** A closed socket: forget it locally, then detach or destroy its session depending on the close code. */
    private async handleClose(connectionId: string, code: number): Promise<void> {
        this.closeWaiters.delete(connectionId);

        const connection: LocalConnection | undefined = this.connectionRegistry.get(connectionId);
        if (!connection) return;

        this.connectionRegistry.delete(connectionId);

        if (connection.sessionId) {
            const invalidated: boolean = GatewayProtocol.sessionInvalidatingCloseCodes.has(code);
            this.logger.info("SESSION", `Session ${connection.sessionId} ${invalidated ? `closed (${code})` : `disconnected (${code}), resumable`}`);
        }

        await this.connectionRegistry.cleanUp(connection, code);
    }

    /** Close code and reason if the requested version (query v) is not supported, otherwise null. */
    private getRejection(request: Request): SocketData["rejection"] {
        const version: string | null = new URL(request.url).searchParams.get("v");

        if (version !== null && version !== String(GatewayProtocol.version)) {
            return {code: GatewayCloseCode.InvalidApiVersion, reason: `Unsupported gateway version ${version}`};
        }
        return null;
    }
}
