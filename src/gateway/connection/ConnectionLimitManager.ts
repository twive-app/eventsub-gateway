import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {HttpProxyService} from "@core/http/HttpProxyService.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {GatewayCloseCode} from "@gateway/GatewayProtocol.ts";
import type {SocketData} from "@gateway/connection/ConnectionRegistry.ts";

/** Failed authentications of one address within the current window. */
interface AuthFailureWindow {
    count: number;
    endsAt: number;
}

const authFailureReason: string = "Too many failed authentication attempts, try again later";

/** Connection limits in memory: total, per address (IPv6 per prefix) and the auth failure block. */
@Bean()
export class ConnectionLimitManager {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private httpProxyService!: HttpProxyService;

    @Autowired()
    private logger!: Logger;

    private total: number = 0;
    private readonly connectionsByAddress: Map<string, number> = new Map<string, number>();
    private readonly authFailures: Map<string, AuthFailureWindow> = new Map<string, AuthFailureWindow>();

    /** Reserves a connection slot for an address; returns a close reason if a limit is reached. */
    public acquire(address: string): SocketData["rejection"] {
        const {maxConnections, maxConnectionsPerIp}: ConfigValues["gateway"] = this.configManager.get().gateway;
        const key: string = this.toKey(address);

        if (this.isBlocked(key)) return {code: GatewayCloseCode.RateLimited, reason: authFailureReason};
        if (maxConnections > 0 && this.total >= maxConnections) {
            return {code: GatewayCloseCode.RateLimited, reason: "Too many connections, try again later"};
        }

        const count: number = this.connectionsByAddress.get(key) ?? 0;
        if (maxConnectionsPerIp > 0 && count >= maxConnectionsPerIp) {
            return {code: GatewayCloseCode.RateLimited, reason: "Too many connections from your address"};
        }

        this.total++;
        this.connectionsByAddress.set(key, count + 1);
        return null;
    }

    /** Frees the slot of a closed connection. */
    public release(address: string): void {
        const key: string = this.toKey(address);
        const count: number = this.connectionsByAddress.get(key) ?? 0;
        if (count === 0) return;

        this.total--;
        if (count === 1) this.connectionsByAddress.delete(key);
        else this.connectionsByAddress.set(key, count - 1);
    }

    /** Close reason if the address is blocked for too many failed authentications, otherwise null. */
    public getAuthRejection(address: string): SocketData["rejection"] {
        return this.isBlocked(this.toKey(address)) ? {code: GatewayCloseCode.RateLimited, reason: authFailureReason} : null;
    }

    /** Counts a failed IDENTIFY/RESUME; reaching the limit blocks the address until the window ends. */
    public recordAuthFailure(address: string): void {
        const {limit, windowMs}: ConfigValues["gateway"]["authFailure"] = this.configManager.get().gateway.authFailure;
        if (limit === 0) return;

        const key: string = this.toKey(address);
        const now: number = Date.now();
        const current: AuthFailureWindow | undefined = this.authFailures.get(key);
        const failures: AuthFailureWindow = current && current.endsAt > now ? current : {count: 0, endsAt: now + windowMs};
        failures.count++;
        this.authFailures.set(key, failures);

        // Log the block once, not for every further attempt.
        if (failures.count === limit) {
            const seconds: number = Math.ceil((failures.endsAt - now) / 1000);
            this.logger.warning("AUTH", `${limit} failed authentications from ${key}, rejecting its connections for ${seconds} seconds`);
        }
    }

    /** Forgets finished auth failure windows every minute so the map doesn't grow. */
    @Cron("0 * * * * *")
    public removeExpiredAuthFailures(): void {
        const now: number = Date.now();
        for (const [key, failures] of this.authFailures) {
            if (failures.endsAt <= now) this.authFailures.delete(key);
        }
    }

    /** Key of an address for the limits (IPv6 cut to its prefix). */
    private toKey(address: string): string {
        return this.httpProxyService.toLimitKey(address, this.configManager.get().gateway.ipv6PrefixLength);
    }

    /** Whether an address has reached the auth failure limit within its window. */
    private isBlocked(key: string): boolean {
        const limit: number = this.configManager.get().gateway.authFailure.limit;
        const failures: AuthFailureWindow | undefined = this.authFailures.get(key);
        return limit > 0 && failures !== undefined && failures.count >= limit && failures.endsAt > Date.now();
    }
}
