import type {RESTPostEventSubSubscriptionRequestBody} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {ClientCredentials} from "@twitch/app/AppAuthenticator.ts";
import type {BotUserUpdate} from "@twitch/app/AppBotUserService.ts";
import type {EventSubConduitManager, EventSubConduitResult} from "@twitch/eventsub/EventSubConduitManager.ts";
import type {EventSubPublicSubscriptionManager} from "@twitch/eventsub/EventSubPublicSubscriptionManager.ts";
import type {EventSubSubscriptionManager} from "@twitch/eventsub/EventSubSubscriptionManager.ts";
import type {EventSubUserSubscriptionManager, RestoredUsers} from "@twitch/eventsub/EventSubUserSubscriptionManager.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";

/** Result of a setup – whether all user subscriptions were restored on a new conduit. */
interface AppSetupResult {
    app: App;
    restoredOnNewConduit: boolean;
}

/** Sets up an application – conduit, authorization subscriptions, user subscriptions – on IDENTIFY and for a repair, one at a time per app. */
@Bean()
export class AppSetupService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private eventSubConduitManager!: EventSubConduitManager;

    @Autowired()
    private eventSubSubscriptionManager!: EventSubSubscriptionManager;

    @Autowired()
    private eventSubUserSubscriptionManager!: EventSubUserSubscriptionManager;

    @Autowired()
    private eventSubPublicSubscriptionManager!: EventSubPublicSubscriptionManager;

    @Autowired()
    private eventSubScopeService!: EventSubScopeService;

    // One setup per app at a time – parallel IDENTIFYs of the same app and the repairs of the conduit check share it.
    private readonly setupLocks: Map<string, Promise<AppSetupResult | null>> = new Map<string, Promise<AppSetupResult | null>>();

    /** Runs (or joins) the setup of an app and moves the bot chat subscriptions if the bot changed. */
    public async setupApplication(clientId: string, credentials: ClientCredentials, botUser: BotUserUpdate): Promise<App | null> {
        // Before the setup: an inactivity check running right now must not remove the conduit anymore.
        await this.appStore.markActive(clientId);

        const result: AppSetupResult | null = await this.shareSetup(clientId, (): Promise<AppSetupResult | null> => this.runSetup(clientId, credentials.accessToken));

        // A setup that restored everything on a new conduit with this bot needs no reconcile.
        const restoredWithBot: boolean = result !== null && result.restoredOnNewConduit && result.app.botUserId === botUser.botUserId;
        if (botUser.changed && !restoredWithBot) {
            void this.eventSubUserSubscriptionManager.reconcileBotSubscriptions(clientId, credentials.accessToken);
        }
        return result?.app ?? null;
    }

    /**
     * Twitch deleted the conduit while clients were connected: a full setup on a new conduit. Null if nothing was
     * repaired – an IDENTIFY set up a new one meanwhile, the inactivity cleanup removed it, or Twitch failed.
     */
    public async repairConduit(clientId: string, conduitId: string, accessToken: string): Promise<App | null> {
        const result: AppSetupResult | null = await this.shareSetup(clientId, async (): Promise<AppSetupResult | null> => {
            if ((await this.appStore.find(clientId))?.conduitId !== conduitId) return null;
            return await this.runSetup(clientId, accessToken);
        });
        return result?.app ?? null;
    }

    /**
     * Twitch revoked the authorization subscriptions (grant/revoke) – without them new users go unnoticed while the
     * clients stay connected. Only these two: the users that authorized meanwhile are unknown, no restore finds them.
     * False if nothing was created (the conduit changed meanwhile, they exist again, or Twitch failed).
     */
    public async restoreAuthorizationSubscriptions(clientId: string, conduitId: string, accessToken: string): Promise<boolean> {
        const result: AppSetupResult | null = await this.shareSetup(clientId, async (): Promise<AppSetupResult | null> => {
            const app: App | null = await this.appStore.find(clientId);
            if (!app || app.conduitId !== conduitId || app.hasAuthorizationSubscriptions) return null;

            const updated: App | null = await this.createAuthorizationSubscriptions(app, conduitId, accessToken);
            return updated ? {app: updated, restoredOnNewConduit: false} : null;
        });
        return result !== null;
    }

    /** Runs the setup of an app, or joins the one running for it. */
    private async shareSetup(clientId: string, setup: () => Promise<AppSetupResult | null>): Promise<AppSetupResult | null> {
        let running: Promise<AppSetupResult | null> | undefined = this.setupLocks.get(clientId);
        if (!running) {
            running = setup().finally((): void => {
                this.setupLocks.delete(clientId);
            });
            this.setupLocks.set(clientId, running);
        }
        return await running;
    }

    /** Conduit, then the authorization subscriptions (once), then the subscriptions of every known user. */
    private async runSetup(clientId: string, accessToken: string): Promise<AppSetupResult | null> {
        const app: App = await this.appStore.findOrCreate(clientId);

        const conduit: EventSubConduitResult | null = await this.eventSubConduitManager.ensureConduit(app, accessToken);
        if (!conduit) return null;

        const result: AppSetupResult | null = await this.setUpConduit(app, conduit, accessToken);
        // Only after their users were taken over – a failed setup keeps them for the next IDENTIFY.
        if (result && conduit.orphanedConduitIds.length > 0) {
            await this.eventSubConduitManager.removeOrphanedConduits(result.app, accessToken, conduit.orphanedConduitIds);
        }
        return result;
    }

    /** The authorization subscriptions and every user on the conduit – skipped if it was set up before. */
    private async setUpConduit(current: App, conduit: EventSubConduitResult, accessToken: string): Promise<AppSetupResult | null> {
        const clientId: string = current.clientId;
        let app: App = current;

        // A new conduit has no subscriptions yet – they are all created again below.
        if (conduit.created) {
            const updated: App | null = await this.appStore.update(clientId, {conduitId: conduit.conduitId, hasAuthorizationSubscriptions: false});
            if (!updated) return null;
            app = updated;
        // Everything was set up before – nothing to do on a normal IDENTIFY (unless leftover conduits have users to take over).
        } else if (app.hasAuthorizationSubscriptions && conduit.orphanedConduitIds.length === 0) {
            return {app, restoredOnNewConduit: false};
        }

        const updated: App | null = await this.createAuthorizationSubscriptions(app, conduit.conduitId, accessToken);
        if (!updated) return null;
        app = updated;

        const restored: RestoredUsers = await this.eventSubUserSubscriptionManager.restoreUserSubscriptions(app, accessToken, conduit.orphanedConduitIds);
        await this.eventSubPublicSubscriptionManager.restorePublicSubscriptions(app, accessToken, restored);

        return {app, restoredOnNewConduit: conduit.created};
    }

    /** user.authorization.grant and .revoke on the conduit, then the flag – null if Twitch failed (the next setup tries again). */
    private async createAuthorizationSubscriptions(app: App, conduitId: string, accessToken: string): Promise<App | null> {
        const subscriptions: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.appSubscriptions(app.clientId, EventSubSubscriptionHelper.conduitTransport(conduitId));
        if (!await this.eventSubSubscriptionManager.subscribe(subscriptions, accessToken, app.clientId)) return null;

        return await this.appStore.update(app.clientId, {hasAuthorizationSubscriptions: true}) ?? app;
    }
}
