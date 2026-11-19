import {beforeEach, describe, expect, test} from "bun:test";
import type {BunRequest} from "bun";
import {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import type {HealthCheck} from "@health/HealthCheckService.ts";
import {MetricsController} from "@health/MetricsController.ts";
import {loadConfig, provideBean} from "../../helpers.ts";
import {ConfigManagerMockup} from "../../mockups/ConfigManagerMockup.ts";

const token: string = "metrics-token-1234567890";
let metrics: MetricsRegistry;

/** A controller with this METRICS_TOKEN (null = off) and a health check whose Redis is down. */
function controller(metricsToken: string | null = token): MetricsController {
    provideBean("configManager", new ConfigManagerMockup(loadConfig({METRICS_TOKEN: metricsToken ?? undefined})));
    provideBean("metricsRegistry", metrics);
    provideBean("healthCheckService", {
        check: async (): Promise<HealthCheck> => ({
            healthy: false,
            failures: ["redis unreachable"],
            status: {
                status: "degraded",
                version: "1.2.3",
                uptime: 42,
                checks: {redis: {ok: false}, gateway: {ok: true}},
                gateway: {connections: 3, sessions: null, applications: null, applicationsNearLimit: 1},
            },
        }),
    });
    return new MetricsController();
}

/** GET /metrics with this Authorization header. */
function scrape(authorization?: string): BunRequest {
    return new Request("http://localhost/metrics", {headers: authorization ? {Authorization: authorization} : {}}) as BunRequest;
}

beforeEach((): void => {
    metrics = new MetricsRegistry();
});

describe("MetricsController", (): void => {
    test("without METRICS_TOKEN the endpoint is off (404)", async (): Promise<void> => {
        expect((await controller(null).metrics(scrape(`Bearer ${token}`))).status).toBe(404);
    });

    test("a missing or wrong token is 401", async (): Promise<void> => {
        expect((await controller().metrics(scrape())).status).toBe(401);
        expect((await controller().metrics(scrape("Bearer wrong-token-1234567890"))).status).toBe(401);
        expect((await controller().metrics(scrape(`Basic ${token}`))).status).toBe(401);
    });

    test("the gauges of the health check and every counter – a value the check couldn't read is left out", async (): Promise<void> => {
        metrics.increment("webhook_messages", "Webhook requests", {type: "notification", result: "accepted"});
        const response: Response = await controller().metrics(scrape(`Bearer ${token}`));
        const text: string = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toStartWith("text/plain; version=0.0.4");
        expect(text).toContain("eventsub_gateway_up 0");
        expect(text).toContain("eventsub_gateway_check_up{check=\"redis\"} 0");
        expect(text).toContain("eventsub_gateway_check_up{check=\"gateway\"} 1");
        expect(text).toContain("eventsub_gateway_connections 3");
        expect(text).toContain("eventsub_gateway_applications_near_limit 1");
        expect(text).toContain("eventsub_gateway_info{version=\"1.2.3\"} 1");
        expect(text).not.toContain("eventsub_gateway_sessions ");
        expect(text).toContain("eventsub_gateway_webhook_messages_total{result=\"accepted\",type=\"notification\"} 1");
    });
});
