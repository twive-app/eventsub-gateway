import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {HttpProxyService} from "@core/http/HttpProxyService.ts";
import {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
// Registers the @OpCode methods (HEARTBEAT, IDENTIFY, RESUME) the server routes to.
import "@gateway/GatewayHandler.ts";
import {GatewayCloseCode, GatewayOpCode, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import {GatewayServer} from "@gateway/GatewayServer.ts";
import {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import {ConnectionRegistry} from "@gateway/connection/ConnectionRegistry.ts";
import {AppAuthFailureLimiter} from "@twitch/app/AppAuthFailureLimiter.ts";
import {loadConfig, provideBean} from "../../helpers.ts";
import {ConfigManagerMockup} from "../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../mockups/LoggerMockup.ts";

/** A real WebSocket client: every frame it received and how the server closed it. */
interface TestClient {
    socket: WebSocket;
    frames: GatewayPayload[];
    closed: Promise<{code: number; reason: string}>;
}

let port: number;
let server: GatewayServer;
let metrics: MetricsRegistry;

/** Connects to the server (path and query as given) and records what arrives. */
async function connect(query: string = "?v=1"): Promise<TestClient> {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const frames: GatewayPayload[] = [];
    socket.addEventListener("message", (event: MessageEvent): void => {
        frames.push(JSON.parse(String(event.data)) as GatewayPayload);
    });
    const closed: Promise<{code: number; reason: string}> = new Promise<{code: number; reason: string}>((resolve: (value: {code: number; reason: string}) => void): void => {
        socket.addEventListener("close", (event: CloseEvent): void => resolve({code: event.code, reason: event.reason}));
    });
    await new Promise<void>((resolve: () => void): void => {
        socket.addEventListener("open", (): void => resolve());
        socket.addEventListener("close", (): void => resolve());
    });
    return {socket, frames, closed};
}

/** Waits until the client received `count` frames. */
async function framesOf(client: TestClient, count: number): Promise<GatewayPayload[]> {
    for (let i: number = 0; i < 100 && client.frames.length < count; i++) await Bun.sleep(10);
    return client.frames;
}

beforeEach((): void => {
    port = 40000 + Math.floor(Math.random() * 20000);
    metrics = new MetricsRegistry();

    provideBean("configManager", new ConfigManagerMockup(loadConfig({
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(port),
        GATEWAY_RATE_LIMIT_MAX_MESSAGES: "3",
    })));
    provideBean("logger", new LoggerMockup());
    provideBean("metricsRegistry", metrics);
    provideBean("httpProxyService", new HttpProxyService());
    provideBean("appAuthFailureLimiter", new AppAuthFailureLimiter());
    provideBean("connectionLimitManager", new ConnectionLimitManager());
    provideBean("connectionStore", {
        createPending: async (): Promise<void> => undefined,
        heartbeat: async (): Promise<void> => undefined,
    });
    provideBean("sessionStore", {
        endConnection: async (): Promise<void> => undefined,
        endConnections: async (): Promise<void> => undefined,
    });
    provideBean("connectionRegistry", new ConnectionRegistry());

    server = new GatewayServer();
    server.initialize();
});

afterEach(async (): Promise<void> => {
    await server.closeConnections();
});

describe("GatewayServer", (): void => {
    test("HELLO right after connecting, HEARTBEAT_ACK for every HEARTBEAT", async (): Promise<void> => {
        const client: TestClient = await connect();
        expect((await framesOf(client, 1))[0]).toEqual({op: GatewayOpCode.Hello, d: {heartbeatInterval: 41250}, s: null, t: null});

        client.socket.send(JSON.stringify({op: GatewayOpCode.Heartbeat, d: null}));
        expect((await framesOf(client, 2))[1].op).toBe(GatewayOpCode.HeartbeatAck);
        client.socket.close(4000);
    });

    test("invalid JSON, a payload without op and an invalid d close with 4002", async (): Promise<void> => {
        for (const [message, reason] of [["{nope", "Invalid JSON"], ["{\"d\": 1}", "Invalid payload"], ["{\"op\": 1, \"d\": {\"clientId\": 1}}", "Invalid IDENTIFY payload"]]) {
            const client: TestClient = await connect();
            await framesOf(client, 1);
            client.socket.send(message);
            expect(await client.closed).toEqual({code: GatewayCloseCode.DecodeError, reason});
        }
    });

    test("an opcode the server doesn't handle closes with 4001", async (): Promise<void> => {
        const client: TestClient = await connect();
        await framesOf(client, 1);
        client.socket.send(JSON.stringify({op: GatewayOpCode.Dispatch, d: null}));

        expect(await client.closed).toEqual({code: GatewayCloseCode.UnknownOpCode, reason: "Unknown opcode 3"});
    });

    test("more payloads than the rate limit allows close with 4007", async (): Promise<void> => {
        const client: TestClient = await connect();
        await framesOf(client, 1);
        for (let i: number = 0; i < 4; i++) client.socket.send(JSON.stringify({op: GatewayOpCode.Heartbeat, d: null}));

        expect(await client.closed).toEqual({code: GatewayCloseCode.RateLimited, reason: "You are sending too many payloads"});
    });

    test("an unsupported version is rejected before HELLO (4009) and counted", async (): Promise<void> => {
        const client: TestClient = await connect("?v=2");

        expect(await client.closed).toEqual({code: GatewayCloseCode.InvalidApiVersion, reason: "Unsupported gateway version 2"});
        expect(client.frames).toEqual([]);
        expect(metrics.get("connections_rejected", {code: "4009"})).toBe(1);
    });

    test("a plain HTTP request gets 426", async (): Promise<void> => {
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(426);
    });
});
