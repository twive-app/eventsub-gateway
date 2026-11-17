import {beforeEach, describe, expect, test} from "bun:test";
import "@core/redis/RedisClient.ts";
import "@gateway/GatewayServer.ts";
import {BeanManager} from "@core/bean/BeanManager.ts";
import {HealthCheckService, type HealthCheck} from "@health/HealthCheckService.ts";
import {provideBean} from "../../helpers.ts";

let ping: () => Promise<number | null>;
let listening: boolean;
let statsRequests: number;

beforeEach((): void => {
    ping = async (): Promise<number | null> => 1.5;
    listening = true;
    statsRequests = 0;

    // The real @HealthCheck methods run against these – RedisClient.checkHealth() pings, GatewayServer's reads `server`.
    provideBean("redisClient", {ping: async (): Promise<number | null> => await ping()});
    provideBean("gatewayServer", {get server(): object | null {
        return listening ? {} : null;
    }});
    provideBean("appStore", {getClientIds: async (): Promise<string[]> => ["abc"]});
    provideBean("sessionStore", {
        getStats: async (): Promise<{sessions: number; applications: number}> => {
            statsRequests++;
            return {sessions: 2, applications: 1};
        },
    });
    provideBean("connectionRegistry", {size: (): number => 3});
    provideBean("eventSubLimitService", {countNearLimit: (): number => 0});
});

describe("HealthCheckService", (): void => {
    test("every @HealthCheck appears by name, with its details", async (): Promise<void> => {
        const health: HealthCheck = await new HealthCheckService().check();

        expect(health.healthy).toBe(true);
        expect(health.status.status).toBe("ok");
        expect(health.status.checks).toMatchObject({redis: {ok: true, latencyMs: 1.5}, gateway: {ok: true}});
        expect(health.status.gateway).toEqual({connections: 3, sessions: 2, applications: 1, applicationsNearLimit: 0});
    });

    test("a check that isn't ok makes it degraded, with its reason", async (): Promise<void> => {
        listening = false;
        const health: HealthCheck = await new HealthCheckService().check();

        expect(health.healthy).toBe(false);
        expect(health.status.status).toBe("degraded");
        expect(health.failures).toEqual(["gateway not listening"]);
    });

    test("without Redis no stats are queried – they would wait for its connection", async (): Promise<void> => {
        ping = async (): Promise<number | null> => null;
        const health: HealthCheck = await new HealthCheckService().check();

        expect(health.failures).toEqual(["redis unreachable"]);
        expect(health.status.gateway.sessions).toBeNull();
        expect(statsRequests).toBe(0);
    });

    test("a check that throws counts as failed", async (): Promise<void> => {
        ping = async (): Promise<number | null> => {
            throw new Error("boom");
        };
        expect((await new HealthCheckService().check()).failures).toEqual(["redis check failed"]);
    });

    test("a name can only be registered once", (): void => {
        const register: () => void = (): void => BeanManager.addHealthCheck({classToken: "OTHER", methodName: "check", name: "redis", handler: (): {ok: boolean} => ({ok: true})});
        expect(register).toThrow("Health check redis is registered twice (OTHER.check)");
    });
});
