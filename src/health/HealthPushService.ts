import {Autowired, Bean, Cron, PostConstruct, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {HealthCheck, HealthCheckService} from "@health/HealthCheckService.ts";

const pushTimeoutMs: number = 5000;
// The cron ticks every second; a push may be due a little early.
const tickToleranceMs: number = 500;

/** Optional heartbeat to HEALTH_PUSH_URL (e.g. an Uptime Kuma push monitor) while the gateway runs. */
@Bean()
export class HealthPushService {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private healthCheckService!: HealthCheckService;

    private lastPushAt: number = 0;
    private stopped: boolean = false;

    /** Logs the push target once – only its host, the URL contains a token. */
    @PostConstruct()
    public initialize(): void {
        const {pushUrl, pushInterval}: ConfigValues["health"] = this.configManager.get().health;
        if (pushUrl) this.logger.info("HEALTH", "Health push enabled", {to: new URL(pushUrl).host, every: `${pushInterval}s`});
    }

    /** Ticks every second and pushes once the interval has passed (the first push right after the start). */
    @Cron("* * * * * *")
    public async tick(): Promise<void> {
        const {pushUrl, pushInterval}: ConfigValues["health"] = this.configManager.get().health;
        if (!pushUrl || this.stopped) return;

        const now: number = Date.now();
        if (this.lastPushAt > 0 && now - this.lastPushAt < pushInterval * 1000 - tickToleranceMs) return;
        this.lastPushAt = now;

        await this.push(new URL(pushUrl));
    }

    /** No more pushes once the shutdown begins. */
    @ShutdownHook(1)
    public stop(): void {
        this.stopped = true;
    }

    /** Calls the push URL – fills status/msg/ping if present (Uptime Kuma), else only pushes while healthy. */
    private async push(url: URL): Promise<void> {
        const health: HealthCheck = await this.healthCheckService.check();
        const params: URLSearchParams = url.searchParams;
        // Without a status parameter, the missing ping raises the alarm.
        if (!health.healthy && !params.has("status")) return;

        if (params.has("status")) params.set("status", health.healthy ? "up" : "down");
        if (params.has("msg") || !health.healthy) params.set("msg", health.healthy ? "OK" : health.failures.join(", "));
        if (params.has("ping") && health.status.checks.redis.latencyMs !== null) params.set("ping", String(health.status.checks.redis.latencyMs));

        try {
            const response: Response = await fetch(url, {signal: AbortSignal.timeout(pushTimeoutMs)});
            await response.body?.cancel();
            if (!response.ok) return this.logger.warnThrottled("HEALTH", "Health push failed", {to: url.host, status: response.status});
            this.logger.debug("HEALTH", "Health pushed", {to: url.host, status: health.healthy ? "up" : "down", failures: health.failures});
        } catch (error) {
            // Only the error code – the URL contains a token.
            this.logger.warnThrottled("HEALTH", "Health push failed", {to: url.host, reason: this.errorCode(error)});
        }
    }

    /** Short error code for the log (e.g. ECONNREFUSED), never the URL. */
    private errorCode(error: unknown): string {
        if (!(error instanceof Error)) return "unknown error";
        return (error as Error & {code?: string}).code ?? error.name;
    }
}
