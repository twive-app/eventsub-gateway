import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {RedisClient} from "@core/redis/RedisClient.ts";
import type {GatewayServer} from "@gateway/GatewayServer.ts";
import type {ConnectionRegistry} from "@gateway/connection/ConnectionRegistry.ts";
import type {GatewayStats, SessionStore} from "@gateway/session/SessionStore.ts";
import type {AppStore} from "@twitch/app/AppStore.ts";
import packageJson from "../../package.json";

const redisPingTimeoutMs: number = 1000;

/** Body of GET /health. */
export interface HealthStatus {
    status: "ok" | "degraded";
    version: string;
    uptime: number;
    checks: {
        redis: {ok: boolean; latencyMs: number | null};
        gateway: {ok: boolean};
    };
    gateway: {connections: number; sessions: number | null; applications: number | null};
}

/** Result of one health check, with the reasons if it failed. */
export interface HealthCheck {
    healthy: boolean;
    status: HealthStatus;
    failures: string[];
}

/** The one health check behind GET /health, the Docker healthcheck and the health push. */
@Bean()
export class HealthCheckService {
    @Autowired()
    private redisClient!: RedisClient;

    @Autowired()
    private gatewayServer!: GatewayServer;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    /** Redis PING with latency, gateway listening, plus the stats while Redis answers. */
    public async check(): Promise<HealthCheck> {
        const latencyMs: number | null = await this.redisClient.ping(redisPingTimeoutMs);
        const redis: boolean = latencyMs !== null;
        const gateway: boolean = this.gatewayServer.isListening();

        let stats: GatewayStats | null = null;
        if (redis) {
            try {
                stats = await this.sessionStore.getStats(await this.appStore.getClientIds());
            } catch {
                // The stats are optional – a failing query doesn't make the gateway unhealthy.
            }
        }

        const failures: string[] = [];
        if (!redis) failures.push("redis unreachable");
        if (!gateway) failures.push("gateway not listening");

        return {
            healthy: failures.length === 0,
            failures,
            status: {
                status: failures.length === 0 ? "ok" : "degraded",
                version: packageJson.version,
                uptime: Math.round(process.uptime()),
                checks: {
                    redis: {ok: redis, latencyMs},
                    gateway: {ok: gateway},
                },
                gateway: {
                    connections: this.connectionRegistry.size(),
                    sessions: stats?.sessions ?? null,
                    applications: stats?.applications ?? null,
                },
            },
        };
    }
}
