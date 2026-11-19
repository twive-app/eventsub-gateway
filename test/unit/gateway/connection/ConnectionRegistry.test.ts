import {afterEach, describe, expect, setSystemTime, test} from "bun:test";
import {GatewayCloseCode, GatewayOpCode} from "@gateway/GatewayProtocol.ts";
import {ConnectionRegistry, type LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import {provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";
import {WebSocketMockup} from "../../../mockups/WebSocketMockup.ts";

describe("ConnectionRegistry.closeReason", (): void => {
    test("keeps short reasons", (): void => {
        expect(ConnectionRegistry.closeReason("Heartbeat timed out")).toBe("Heartbeat timed out");
    });

    test("cuts reasons to the 123 bytes a close frame allows, also with multi-byte characters", (): void => {
        for (const reason of [`Unknown events: ${"X".repeat(400)}`, "ü".repeat(200), "✓".repeat(100)]) {
            const cut: string = ConnectionRegistry.closeReason(reason);
            expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(123);
            expect(cut.endsWith("…")).toBe(true);
        }
    });
});

describe("ConnectionRegistry.consumeRateLimit", (): void => {
    const registry: ConnectionRegistry = new ConnectionRegistry();

    afterEach((): void => {
        setSystemTime();
    });

    test("allows maxMessages per window and starts a new window afterward", (): void => {
        const connection: LocalConnection = {rateLimitCount: 0, rateLimitWindowEndsAt: 0} as LocalConnection;
        setSystemTime(new Date("2026-11-16T12:00:00Z"));

        expect([1, 2, 3].map((): boolean => registry.consumeRateLimit(connection, 3, 60000))).toEqual([true, true, true]);
        expect(registry.consumeRateLimit(connection, 3, 60000)).toBe(false);

        setSystemTime(new Date("2026-11-16T12:01:00Z"));
        expect(registry.consumeRateLimit(connection, 3, 60000)).toBe(true);
    });

    test("the window starts with the first message, later ones don't extend it", (): void => {
        const connection: LocalConnection = {rateLimitCount: 0, rateLimitWindowEndsAt: 0} as LocalConnection;
        setSystemTime(new Date("2026-11-16T12:00:00Z"));
        registry.consumeRateLimit(connection, 2, 60000);

        setSystemTime(new Date("2026-11-16T12:00:59Z"));
        registry.consumeRateLimit(connection, 2, 60000);
        expect(registry.consumeRateLimit(connection, 2, 60000)).toBe(false);

        setSystemTime(new Date("2026-11-16T12:01:00Z"));
        expect(registry.consumeRateLimit(connection, 2, 60000)).toBe(true);
    });
});

describe("ConnectionRegistry.reconnectApp", (): void => {
    test("RECONNECT and 4012 to the identified connections of that app only", (): void => {
        provideBean("configManager", new ConfigManagerMockup());
        provideBean("logger", new LoggerMockup());
        const registry: ConnectionRegistry = new ConnectionRegistry();

        const sockets: Record<string, WebSocketMockup> = {};
        const identify: (connectionId: string, clientId: string | null) => void = (connectionId: string, clientId: string | null): void => {
            sockets[connectionId] = new WebSocketMockup(connectionId);
            const connection: LocalConnection = registry.add(sockets[connectionId].asSocket());
            connection.clientId = clientId;
            connection.sessionId = clientId ? `session-${connectionId}` : null;
        };
        identify("c1", "abc");
        identify("c2", "abc");
        identify("c3", "other");
        identify("c4", null);

        expect(registry.reconnectApp("abc", "App access token renewal, RESUME")).toBe(2);

        for (const id of ["c1", "c2"]) {
            expect(sockets[id].frames.map((frame: {op: number}): number => frame.op)).toEqual([GatewayOpCode.Reconnect]);
            expect(sockets[id].closed).toEqual({code: GatewayCloseCode.ReconnectRequested, reason: "App access token renewal, RESUME"});
        }
        expect(sockets.c3.closed).toBeNull();
        expect(sockets.c4.closed).toBeNull();
    });
});
