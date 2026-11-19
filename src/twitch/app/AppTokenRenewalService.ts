import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ConnectionRegistry} from "@gateway/connection/ConnectionRegistry.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {AppStore} from "@twitch/app/AppStore.ts";

/**
 * The gateway never stores a client secret, so only an IDENTIFY or RESUME can renew an app access token (Twitch's last
 * about 60 days). A client that stays connected longer would leave the gateway – and itself – with an expired token:
 * grants would be lost, the conduit check would stop. A day before it expires, its connections get RECONNECT; their
 * RESUME renews the token and RESUMED hands the new one to the client.
 */
@Bean()
export class AppTokenRenewalService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    @Autowired()
    private logger!: Logger;

    /** Hourly (quarter past, apart from the other checks): reconnects the clients of apps whose token expires soon. */
    @Cron("0 15 * * * *")
    public async renewExpiringTokens(): Promise<void> {
        for (const clientId of await this.appStore.getClientIds()) {
            try {
                if (!await this.appAuthenticator.needsRenewal(clientId) || !await this.sessionStore.hasSessions(clientId)) continue;

                const count: number = this.connectionRegistry.reconnectApp(clientId, "App access token renewal, RESUME");
                if (count > 0) this.logger.info("AUTH", "App access token expires soon, clients asked to RESUME", {app: clientId, connections: count});
            } catch (error) {
                this.logger.warnThrottled("AUTH", "Could not check the app access token", {app: clientId}, error);
            }
        }
    }
}
