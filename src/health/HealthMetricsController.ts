import crypto from "node:crypto";
import type {BunRequest} from "bun";
import {Autowired, Bean, Route} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import {HttpErrorResponse} from "@core/http/HttpErrorResponse.ts";
import type {MetricFamily, MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import type {HealthCheck, HealthCheckService} from "@health/HealthCheckService.ts";

/** GET /metrics for Prometheus – with `Authorization: Bearer <METRICS_TOKEN>`, off without a token. */
@Bean()
export class HealthMetricsController {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    @Autowired()
    private healthCheckService!: HealthCheckService;

    /** The gauges of the health check plus every counter, in the Prometheus text format. */
    @Route("GET", "/metrics")
    public async metrics(request: BunRequest): Promise<Response> {
        const token: string | undefined = this.configManager.get().metrics.token;
        // Off: the endpoint doesn't exist.
        if (!token) return HttpErrorResponse.format(404, "Not Found", "Route GET:/metrics not found");
        if (!HealthMetricsController.hasToken(request.headers.get("Authorization"), token)) {
            return HttpErrorResponse.format(401, "Unauthorized", "Authorization: Bearer <METRICS_TOKEN> required", {
                "WWW-Authenticate": "Bearer",
            });
        }

        const health: HealthCheck = await this.healthCheckService.check();
        return new Response(this.metricsRegistry.render(this.gauges(health)), {
            headers: {
                "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            },
        });
    }

    /** What /health knows, as gauges – a value the check couldn't read (e.g. sessions without Redis) is left out. */
    private gauges(health: HealthCheck): MetricFamily[] {
        const {checks, gateway, uptime, version}: HealthCheck["status"] = health.status;
        const redisLatency: unknown = checks.redis?.latencyMs;
        const optional: (value: number | null) => {value: number}[] = (value: number | null): {value: number}[] => value === null ? [] : [{value}];

        return [
            this.metricsRegistry.gauge("info", "Version of the gateway", [{
                labels: {version},
                value: 1,
            }]),
            this.metricsRegistry.gauge("up", "1 while every health check passes", [{
                value: health.healthy ? 1 : 0,
            }]),
            this.metricsRegistry.gauge("check_up", "1 per passing health check", Object.entries(checks).map(
                ([check, result]: [string, {ok: boolean}]): {labels: Record<string, string>; value: number} => ({
                    labels: {check},
                    value: result.ok ? 1 : 0,
                }),
            )),
            this.metricsRegistry.gauge("redis_latency_seconds", "Round trip of the Redis PING", typeof redisLatency === "number" ? [{
                value: redisLatency / 1000,
            }] : []),
            this.metricsRegistry.gauge("uptime_seconds", "Seconds since the start", [{
                value: uptime,
            }]),
            this.metricsRegistry.gauge("connections", "Open WebSocket connections of this instance", [{
                value: gateway.connections,
            }]),
            this.metricsRegistry.gauge("sessions", "Sessions, connected or resumable", optional(gateway.sessions)),
            this.metricsRegistry.gauge("applications", "Applications with at least one session", optional(gateway.applications)),
            this.metricsRegistry.gauge("applications_near_limit", "Applications at 80 % or more of Twitch's subscription limit", [{
                value: gateway.applicationsNearLimit,
            }]),
        ];
    }

    /** Whether the header carries the token – compared in constant time. */
    private static hasToken(header: string | null, token: string): boolean {
        const match: RegExpMatchArray | null = header?.match(/^Bearer\s+(.+)$/i) ?? null;
        if (!match) return false;

        const expected: Buffer = crypto.createHash("sha256").update(token).digest();
        const received: Buffer = crypto.createHash("sha256").update(match[1].trim()).digest();
        return crypto.timingSafeEqual(expected, received);
    }
}
