import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {HttpProxyService} from "@core/http/HttpProxyService.ts";
import type {Logger} from "@core/logging/Logger.ts";

/** Failed authentications of one address within the current window. */
interface AuthFailureWindow {
    count: number;
    endsAt: number;
}

/**
 * Blocks an address after too many wrong client ids or secrets (GATEWAY_AUTH_FAILURE_*) – for IDENTIFY, RESUME and
 * /twitch/subscriptions alike, so no way in can be used to guess secrets. In memory, IPv6 per prefix.
 */
@Bean()
export class AuthFailureLimiter {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private httpProxyService!: HttpProxyService;

    @Autowired()
    private logger!: Logger;

    private readonly failures: Map<string, AuthFailureWindow> = new Map<string, AuthFailureWindow>();

    /** Whether the address reached the limit within its window. */
    public isBlocked(address: string): boolean {
        const limit: number = this.configManager.get().gateway.authFailure.limit;
        const failures: AuthFailureWindow | undefined = this.failures.get(this.toKey(address));
        return limit > 0 && failures !== undefined && failures.count >= limit && failures.endsAt > Date.now();
    }

    /** Counts a rejected client id or secret; reaching the limit blocks the address until the window ends. */
    public recordFailure(address: string): void {
        const {limit, windowMs}: ConfigValues["gateway"]["authFailure"] = this.configManager.get().gateway.authFailure;
        if (limit === 0) return;

        const key: string = this.toKey(address);
        const now: number = Date.now();
        const current: AuthFailureWindow | undefined = this.failures.get(key);
        const failures: AuthFailureWindow = current && current.endsAt > now ? current : {count: 0, endsAt: now + windowMs};
        failures.count++;
        this.failures.set(key, failures);

        // Log the block once, not for every further attempt.
        if (failures.count === limit) {
            const seconds: number = Math.ceil((failures.endsAt - now) / 1000);
            this.logger.warn("AUTH", "Too many failed authentications, address blocked", {ip: key, failures: limit, time: `${seconds}s`});
        }
    }

    /** Forgets finished windows every minute so the map doesn't grow. */
    @Cron("0 * * * * *")
    public removeExpired(): void {
        const now: number = Date.now();
        for (const [key, failures] of this.failures) {
            if (failures.endsAt <= now) this.failures.delete(key);
        }
    }

    /** Key of an address (IPv6 cut to its prefix, like the connection limits). */
    private toKey(address: string): string {
        return this.httpProxyService.toLimitKey(address, this.configManager.get().gateway.ipv6PrefixLength);
    }
}
