import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {AppSetupService} from "@twitch/app/AppSetupService.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubConduitCheck, EventSubConduitManager} from "@twitch/eventsub/EventSubConduitManager.ts";

/**
 * Every 5 minutes, for apps with clients: re-enables a shard Twitch disabled, sets up a conduit Twitch deleted and
 * creates revoked authorization subscriptions again – otherwise events would stop without an error until the next
 * IDENTIFY. Apps without a client aren't checked, their next IDENTIFY sets them up.
 */
@Bean()
export class AppConduitCheckService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private eventSubConduitManager!: EventSubConduitManager;

    @Autowired()
    private appSetupService!: AppSetupService;

    @Autowired()
    private logger!: Logger;

    /** Checks the conduit of every app – a failing app doesn't stop the others. */
    @Cron("0 */5 * * * *")
    public async checkConduits(): Promise<void> {
        for (const clientId of await this.appStore.getClientIds()) {
            try {
                await this.checkConduit(clientId);
            } catch (error) {
                this.logger.error("CONDUIT", "Conduit check failed", {app: clientId}, error);
            }
        }
    }

    /** The check of one app – only while it has a client (connected or about to RESUME). */
    private async checkConduit(clientId: string): Promise<void> {
        const app: App | null = await this.appStore.find(clientId);
        if (!app?.conduitId || !await this.sessionStore.hasSessions(clientId)) return;

        const accessToken: string | null = await this.appAuthenticator.getAppAccessToken(clientId);
        if (!accessToken) return;

        const conduitId: string = app.conduitId;
        const check: EventSubConduitCheck = await this.eventSubConduitManager.checkConduit(app, accessToken, conduitId);
        if (check === "failed") return;

        if (check === "gone") {
            this.logger.warn("CONDUIT", "Deleted at Twitch while clients were connected, setting up a new one", {id: conduitId, app: clientId});
            const repaired: App | null = await this.appSetupService.repairConduit(clientId, conduitId, accessToken);
            if (repaired) this.logger.success("CONDUIT", "New conduit set up, subscriptions restored", {id: repaired.conduitId, app: clientId});
            return;
        }

        if (!app.hasAuthorizationSubscriptions && await this.appSetupService.restoreAuthorizationSubscriptions(clientId, conduitId, accessToken)) {
            this.logger.success("EVENTSUB", "Authorization subscriptions created again", {app: clientId});
        }
    }
}
