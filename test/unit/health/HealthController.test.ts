import {describe, expect, test} from "bun:test";
import {HealthController} from "@health/HealthController.ts";
import type {HealthCheck} from "@health/HealthCheckService.ts";
import {provideBean} from "../../helpers.ts";

/** A controller whose health check passes or not. */
function controller(healthy: boolean): HealthController {
    provideBean("healthCheckService", {
        check: async (): Promise<HealthCheck> => ({
            healthy,
            failures: healthy ? [] : ["redis unreachable"],
            status: {
                status: healthy ? "ok" : "degraded",
                version: "1.2.3",
                uptime: 1,
                checks: {redis: {ok: healthy}, gateway: {ok: true}},
                gateway: {connections: 0, sessions: null, applications: null, applicationsNearLimit: 0},
            },
        }),
    });
    return new HealthController();
}

describe("HealthController", (): void => {
    test("200 with status ok while every check passes, otherwise 503 with degraded – Docker and monitors read the code", async (): Promise<void> => {
        const ok: Response = await controller(true).health();
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({status: "ok", checks: {redis: {ok: true}}});

        const degraded: Response = await controller(false).health();
        expect(degraded.status).toBe(503);
        expect(await degraded.json()).toMatchObject({status: "degraded", checks: {redis: {ok: false}}});
    });
});
