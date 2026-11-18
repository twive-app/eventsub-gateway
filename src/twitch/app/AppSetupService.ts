import type {RESTGetUsersResponse, RESTPostEventSubSubscriptionRequestBody} from "twitch-dev-types";
import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {AppAuthenticator, ClientCredentials} from "@twitch/app/AppAuthenticator.ts";
import type {EventSubConduitCheck, EventSubConduitManager, EventSubConduitResult} from "@twitch/eventsub/EventSubConduitManager.ts";
import type {EventSubPublicSubscriptionManager} from "@twitch/eventsub/EventSubPublicSubscriptionManager.ts";
import type {EventSubSubscriptionManager, RestoredUsers} from "@twitch/eventsub/EventSubSubscriptionManager.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";

/** Bot user after IDENTIFY and whether it changed. */
export interface BotUserUpdate {
    botUserId: string | null;
    changed: boolean;
}

/** Result of a setup – whether all user subscriptions were restored on a new conduit. */
interface AppSetupResult {
    app: App;
    restoredOnNewConduit: boolean;
}

// Bot changes within this window count as flapping (several clients with different bots).
const botUserFlappingWindowMs: number = 5 * 60 * 1000;

/** Sets up an application on IDENTIFY: bot user, conduit, authorization subscriptions and user subscriptions. */
@Bean()
export class AppSetupService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private eventSubConduitManager!: EventSubConduitManager;

    @Autowired()
    private eventSubSubscriptionManager!: EventSubSubscriptionManager;

    @Autowired()
    private eventSubPublicSubscriptionManager!: EventSubPublicSubscriptionManager;

    @Autowired()
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private logger!: Logger;

    // One setup per app at a time – parallel IDENTIFYs of the same app (and the conduit check) share it.
    private readonly setupLocks: Map<string, Promise<AppSetupResult | null>> = new Map<string, Promise<AppSetupResult | null>>();
    private readonly botUserChanges: Map<string, number[]> = new Map<string, number[]>();
    private readonly botUserWarnings: Map<string, number> = new Map<string, number>();

    /** Runs (or joins) the setup of an app and moves the bot chat subscriptions if the bot changed. */
    public async setupApplication(clientId: string, credentials: ClientCredentials, botUser: BotUserUpdate): Promise<App | null> {
        // Before the setup: an inactivity check running right now must not remove the conduit any more.
        await this.appStore.markActive(clientId);

        const result: AppSetupResult | null = await this.shareSetup(clientId, (): Promise<AppSetupResult | null> => this.runSetup(clientId, credentials.accessToken));

        // A setup that restored everything on a new conduit with this bot needs no reconcile.
        const restoredWithBot: boolean = result !== null && result.restoredOnNewConduit && result.app.botUserId === botUser.botUserId;
        if (botUser.changed && !restoredWithBot) {
            this.eventSubSubscriptionManager.reconcileBotSubscriptions(clientId, credentials.accessToken).catch((error: unknown): void => {
                this.logger.error("EVENTSUB", "Could not move the bot chat subscriptions", {app: clientId}, error);
            });
        }
        return result?.app ?? null;
    }

    /**
     * Every 5 minutes, for apps with clients: re-enables a shard Twitch disabled and sets up a conduit Twitch deleted –
     * otherwise events would stop without an error until the next IDENTIFY. Apps without a client are checked by it.
     */
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

    /** botUserId of IDENTIFY: undefined keeps the bot, null removes it, a new id is checked (null = unknown). */
    public async updateBotUser(clientId: string, botUserId: string | null | undefined, accessToken: string): Promise<BotUserUpdate | null> {
        const app: App = await this.appStore.findOrCreate(clientId);
        if (botUserId === undefined || botUserId === app.botUserId) return {botUserId: app.botUserId, changed: false};
        if (botUserId !== null && !await this.botUserExists(clientId, botUserId, accessToken)) return null;

        const updated: App | null = await this.appStore.update(clientId, {botUserId});
        if (!updated) return {botUserId: app.botUserId, changed: false};

        this.logger.info("APP", "Bot user changed", {app: clientId, from: app.botUserId ?? "none", to: botUserId ?? "none"});
        this.warnOnFlappingBotUser(clientId, botUserId);
        return {botUserId, changed: true};
    }

    /** Warns once per window if the bot of an app keeps changing. */
    private warnOnFlappingBotUser(clientId: string, botUserId: string | null): void {
        const now: number = Date.now();
        const changes: number[] = (this.botUserChanges.get(clientId) ?? []).filter((at: number): boolean => now - at < botUserFlappingWindowMs);
        changes.push(now);
        this.botUserChanges.set(clientId, changes);

        if (changes.length < 2 || now - (this.botUserWarnings.get(clientId) ?? 0) < botUserFlappingWindowMs) return;

        this.botUserWarnings.set(clientId, now);
        this.logger.warn("APP", "Bot user keeps changing – clients with different botUserIds?", {app: clientId, changes: changes.length, within: "5m", now: botUserId ?? "none"});
    }

    /** Whether the bot user exists – a Helix failure doesn't block IDENTIFY, only a clear "no" does. */
    private async botUserExists(clientId: string, botUserId: string, accessToken: string): Promise<boolean> {
        try {
            const response: RESTGetUsersResponse = await this.twitchClient.getUsersById([botUserId], {accessToken, clientId});
            return response.data.length > 0;
        } catch (error) {
            if (HttpError.statusOf(error) === 400) return false;

            this.logger.warn("APP", "Could not verify the bot user, storing it unverified", {app: clientId, bot: botUserId}, error);
            return true;
        }
    }

    /** The conduit check of one app – only while it has a client (connected or about to RESUME). */
    private async checkConduit(clientId: string): Promise<void> {
        const app: App | null = await this.appStore.find(clientId);
        if (!app?.conduitId || !await this.sessionStore.hasSessions(clientId)) return;

        const accessToken: string | null = await this.appAuthenticator.getAppAccessToken(clientId);
        if (!accessToken) return;

        const conduitId: string = app.conduitId;
        const check: EventSubConduitCheck = await this.eventSubConduitManager.checkConduit(app, accessToken, conduitId);
        if (check !== "gone") {
            if (check !== "failed" && !app.hasAuthorizationSubscriptions) await this.restoreAuthorizationSubscriptions(clientId, conduitId, accessToken);
            return;
        }

        this.logger.warn("CONDUIT", "Deleted at Twitch while clients were connected, setting up a new one", {id: conduitId, app: clientId});
        const result: AppSetupResult | null = await this.shareSetup(clientId, async (): Promise<AppSetupResult | null> => {
            // Changed meanwhile (an IDENTIFY set up a new one, the inactivity cleanup removed it) – nothing to repair.
            if ((await this.appStore.find(clientId))?.conduitId !== conduitId) return null;
            return await this.runSetup(clientId, accessToken);
        });
        if (result) this.logger.success("CONDUIT", "New conduit set up, subscriptions restored", {id: result.app.conduitId, app: clientId});
    }

    /**
     * Twitch revoked the authorization subscriptions (grant/revoke) – without them new users go unnoticed while the
     * clients stay connected. Only these two: the users that authorized meanwhile are unknown, no restore finds them.
     */
    private async restoreAuthorizationSubscriptions(clientId: string, conduitId: string, accessToken: string): Promise<void> {
        const result: AppSetupResult | null = await this.shareSetup(clientId, async (): Promise<AppSetupResult | null> => {
            const app: App | null = await this.appStore.find(clientId);
            if (!app || app.conduitId !== conduitId || app.hasAuthorizationSubscriptions) return null;

            const subscriptions: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.appSubscriptions(clientId, this.eventSubScopeService.conduitTransport(conduitId));
            if (!await this.eventSubSubscriptionManager.subscribe(subscriptions, accessToken, clientId)) return null;

            const updated: App | null = await this.appStore.update(clientId, {hasAuthorizationSubscriptions: true});
            return updated ? {app: updated, restoredOnNewConduit: false} : null;
        });
        if (result) this.logger.success("EVENTSUB", "Authorization subscriptions created again", {app: clientId});
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

        const subscriptions: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.appSubscriptions(app.clientId, this.eventSubScopeService.conduitTransport(conduit.conduitId));

        const created: boolean = await this.eventSubSubscriptionManager.subscribe(subscriptions, accessToken, app.clientId);
        if (!created) return null;

        app = await this.appStore.update(clientId, {hasAuthorizationSubscriptions: true}) ?? app;

        const restored: RestoredUsers = await this.eventSubSubscriptionManager.restoreUserSubscriptions(app, accessToken, conduit.orphanedConduitIds);
        await this.eventSubPublicSubscriptionManager.restorePublicSubscriptions(app, accessToken, restored);

        return {app, restoredOnNewConduit: conduit.created};
    }
}
