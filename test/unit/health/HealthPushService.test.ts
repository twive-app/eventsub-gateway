import {afterEach, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import type {HealthCheck} from "@health/HealthCheckService.ts";
import {HealthPushService} from "@health/HealthPushService.ts";
import {loadConfig, provideBean} from "../../helpers.ts";
import {ConfigManagerMockup} from "../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../mockups/LoggerMockup.ts";

const originalFetch: typeof fetch = globalThis.fetch;
let pushed: URL[];
let healthy: boolean;

/** The health check result: healthy with a Redis latency, or Redis down. */
function healthCheck(): HealthCheck {
    return {
        healthy,
        failures: healthy ? [] : ["redis unreachable"],
        status: {
            status: healthy ? "ok" : "degraded",
            version: "1.2.3",
            uptime: 1,
            checks: {redis: healthy ? {ok: true, latencyMs: 0.7} : {ok: false, latencyMs: null}, gateway: {ok: true}},
            gateway: {connections: 0, sessions: 0, applications: 0, applicationsNearLimit: 0},
        },
    };
}

/** A push service with this HEALTH_PUSH_URL. */
function service(pushUrl: string | undefined): HealthPushService {
    provideBean("configManager", new ConfigManagerMockup(loadConfig({HEALTH_PUSH_URL: pushUrl, HEALTH_PUSH_INTERVAL: "60"})));
    provideBean("logger", new LoggerMockup());
    provideBean("healthCheckService", {check: async (): Promise<HealthCheck> => healthCheck()});
    return new HealthPushService();
}

beforeEach((): void => {
    pushed = [];
    healthy = true;
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
        pushed.push(new URL(String(input)));
        return new Response("ok");
    }) as typeof fetch;
});

afterEach((): void => {
    globalThis.fetch = originalFetch;
    setSystemTime();
});

describe("HealthPushService", (): void => {
    test("Uptime Kuma: status, msg and ping are filled in", async (): Promise<void> => {
        const push: HealthPushService = service("https://kuma.example.com/api/push/abc?status=up&msg=OK&ping=");
        await push.tick();
        healthy = false;
        setSystemTime(new Date("2026-11-20T12:01:00Z"));
        await push.tick();

        expect(pushed.map((url: URL): string => url.search)).toEqual(["?status=up&msg=OK&ping=0.7", "?status=down&msg=redis+unreachable&ping="]);
    });

    test("without a status parameter only a healthy gateway pushes – the missing ping raises the alarm", async (): Promise<void> => {
        const push: HealthPushService = service("https://hc-ping.com/abc");
        healthy = false;
        await push.tick();

        expect(pushed).toEqual([]);
    });

    test("once per interval, the first push right away; nothing after the shutdown began", async (): Promise<void> => {
        const push: HealthPushService = service("https://hc-ping.com/abc");
        await push.tick();
        setSystemTime(new Date("2026-11-20T12:00:30Z"));
        await push.tick();
        setSystemTime(new Date("2026-11-20T12:01:00Z"));
        await push.tick();
        expect(pushed).toHaveLength(2);

        push.stop();
        setSystemTime(new Date("2026-11-20T12:02:00Z"));
        await push.tick();
        expect(pushed).toHaveLength(2);
    });

    test("without HEALTH_PUSH_URL nothing is pushed", async (): Promise<void> => {
        await service(undefined).tick();
        expect(pushed).toEqual([]);
    });
});
