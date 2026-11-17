import {afterEach, describe, expect, setSystemTime, test} from "bun:test";
import {ConnectionRegistry, type LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";

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
