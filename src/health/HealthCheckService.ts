import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {BeanManager, type HealthCheckResult, type ServerHealthCheck} from "@core/bean/BeanManager.ts";
import type {ConnectionRegistry} from "@gateway/connection/ConnectionRegistry.ts";
import type {GatewayStats, SessionStore} from "@gateway/session/SessionStore.ts";
import type {AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import packageJson from "../../package.json";

/** One check in the body of GET /health: `ok` plus its details (e.g. `latencyMs` of redis). */
export type HealthCheckStatus = {ok: boolean} & Record<string, unknown>;

/** Body of GET /health. */
export interface HealthStatus {
    status: "ok" | "degraded";
    version: string;
    uptime: number;
    // Every @HealthCheck by name – redis (RedisClient), gateway (GatewayServer).
    checks: Record<string, HealthCheckStatus>;
    // applicationsNearLimit: apps at ≥ 80 % of Twitch's subscription limit – only informational, never unhealthy.
    gateway: {
        connections: number;
        sessions: number | null;
        applications: number | null;
        applicationsNearLimit: number;
    };
}

/** Result of one health check, with the reasons if it failed. */
export interface HealthCheck {
    healthy: boolean;
    status: HealthStatus;
    failures: string[];
}

/** The one health check behind GET /health, the Docker healthcheck and the health push – it runs every @HealthCheck. */
@Bean()
export class HealthCheckService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    @Autowired()
    private eventSubLimitService!: EventSubLimitService;

    /** Every @HealthCheck at once, plus the stats while Redis answers. */
    public async check(): Promise<HealthCheck> {
        const results: [string, HealthCheckResult][] = await Promise.all(BeanManager.getHealthChecks().map(
            async ({name, check}: ServerHealthCheck): Promise<[string, HealthCheckResult]> => {
                try {
                    return [name, await check()];
                } catch {
                    return [name, {
                        ok: false,
                        failure: `${name} check failed`,
                    }];
                }
            }),
        );

        const checks: Record<string, HealthCheckStatus> = {};
        const failures: string[] = [];
        for (const [name, result] of results) {
            checks[name] = {
                ok: result.ok,
                ...result.details,
            };
            if (!result.ok) failures.push(result.failure ?? `${name} check failed`);
        }

        // Without Redis the stats would wait for its connection – they are optional, a failing query is ignored.
        let stats: GatewayStats | null = null;
        if (checks.redis?.ok) {
            try {
                stats = await this.sessionStore.getStats(await this.appStore.getClientIds());
            } catch {
                // The stats don't make the gateway unhealthy.
            }
        }

        return {
            healthy: failures.length === 0,
            failures,
            status: {
                status: failures.length === 0 ? "ok" : "degraded",
                version: packageJson.version,
                uptime: Math.round(process.uptime()),
                checks,
                gateway: {
                    connections: this.connectionRegistry.size(),
                    sessions: stats?.sessions ?? null,
                    applications: stats?.applications ?? null,
                    applicationsNearLimit: this.eventSubLimitService.countNearLimit(),
                },
            },
        };
    }
}
