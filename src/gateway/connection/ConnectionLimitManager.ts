import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {ProxyService} from "@core/proxy/ProxyService.ts";
import {GatewayCloseCode} from "@gateway/GatewayProtocol.ts";
import type {SocketData} from "@gateway/connection/ConnectionRegistry.ts";
import type {AppAuthFailureLimiter} from "@twitch/app/AppAuthFailureLimiter.ts";

const authFailureReason: string = "Too many failed authentication attempts, try again later";

/** Connection limits in memory: total and per address (IPv6 per prefix); a blocked address gets no connection either. */
@Bean()
export class ConnectionLimitManager {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private proxyService!: ProxyService;

    @Autowired()
    private appAuthFailureLimiter!: AppAuthFailureLimiter;

    private total: number = 0;
    private readonly connectionsByAddress: Map<string, number> = new Map<string, number>();

    /** Reserves a connection slot for an address; returns a close reason if a limit is reached. */
    public acquire(address: string): SocketData["rejection"] {
        const {maxConnections, maxConnectionsPerIp}: ConfigValues["gateway"] = this.configManager.get().gateway;
        const key: string = this.toKey(address);

        const blocked: SocketData["rejection"] = this.getAuthRejection(address);
        if (blocked) return blocked;
        if (maxConnections > 0 && this.total >= maxConnections) {
            return {
                code: GatewayCloseCode.RateLimited,
                reason: "Too many connections, try again later",
            };
        }

        const count: number = this.connectionsByAddress.get(key) ?? 0;
        if (maxConnectionsPerIp > 0 && count >= maxConnectionsPerIp) {
            return {
                code: GatewayCloseCode.RateLimited,
                reason: "Too many connections from your address",
            };
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
        return this.appAuthFailureLimiter.isBlocked(address) ? {
            code: GatewayCloseCode.RateLimited,
            reason: authFailureReason,
        } : null;
    }

    /** Key of an address for the limits (IPv6 cut to its prefix). */
    private toKey(address: string): string {
        return this.proxyService.toLimitKey(address, this.configManager.get().gateway.ipv6PrefixLength);
    }
}
