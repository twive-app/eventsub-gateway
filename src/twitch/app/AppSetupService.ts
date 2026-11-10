import {EventSubTransportMethod, type RESTGetUsersResponse, type RESTPostEventSubSubscriptionRequestBody} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {ClientCredentials} from "@twitch/app/AppAuthenticator.ts";
import type {EventSubConduitManager, EventSubConduitResult} from "@twitch/eventsub/EventSubConduitManager.ts";
import type {EventSubSubscriptionManager} from "@twitch/eventsub/EventSubSubscriptionManager.ts";
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
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    // One setup per app at a time – parallel IDENTIFYs of the same app share it.
    private readonly setupLocks: Map<string, Promise<AppSetupResult | null>> = new Map<string, Promise<AppSetupResult | null>>();
    private readonly botUserChanges: Map<string, number[]> = new Map<string, number[]>();
    private readonly botUserWarnings: Map<string, number> = new Map<string, number>();

    /** Runs (or joins) the setup of an app and moves the bot chat subscriptions if the bot changed. */
    public async setupApplication(clientId: string, credentials: ClientCredentials, botUser: BotUserUpdate): Promise<App | null> {
        let setup: Promise<AppSetupResult | null> | undefined = this.setupLocks.get(clientId);
        if (!setup) {
            setup = this.runSetup(clientId, credentials).finally((): void => {
                this.setupLocks.delete(clientId);
            });
            this.setupLocks.set(clientId, setup);
        }

        const result: AppSetupResult | null = await setup;

        // A setup that restored everything on a new conduit with this bot needs no reconcile.
        const restoredWithBot: boolean = result !== null && result.restoredOnNewConduit && result.app.botUserId === botUser.botUserId;
        if (botUser.changed && !restoredWithBot) {
            this.eventSubSubscriptionManager.reconcileBotSubscriptions(clientId, credentials.accessToken).catch((error: unknown): void => {
                this.logger.error("EVENTSUB", `Failed to reconcile the bot chat subscriptions of application ${clientId}`);
                this.errorReporter.handle(error, {clientId});
            });
        }
        return result?.app ?? null;
    }

    /** botUserId of IDENTIFY: undefined keeps the bot, null removes it, a new id is checked (null = unknown). */
    public async updateBotUser(clientId: string, botUserId: string | null | undefined, accessToken: string): Promise<BotUserUpdate | null> {
        const app: App = await this.appStore.findOrCreate(clientId);
        if (botUserId === undefined || botUserId === app.botUserId) return {botUserId: app.botUserId, changed: false};
        if (botUserId !== null && !await this.botUserExists(clientId, botUserId, accessToken)) return null;

        const updated: App | null = await this.appStore.update(clientId, {botUserId});
        if (!updated) return {botUserId: app.botUserId, changed: false};

        this.logger.info("AUTH", `Bot user of application ${clientId} changed from ${app.botUserId ?? "none"} to ${botUserId ?? "none"}`);
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
        this.logger.warning("AUTH", `Bot user of application ${clientId} changed ${changes.length} times within 5 minutes (now ${botUserId ?? "none"}) `
            + "– do several clients IDENTIFY with different botUserIds?");
    }

    /** Whether the bot user exists – a Helix failure doesn't block IDENTIFY, only a clear "no" does. */
    private async botUserExists(clientId: string, botUserId: string, accessToken: string): Promise<boolean> {
        try {
            const response: RESTGetUsersResponse = await this.twitchClient.getUsersById([botUserId], {accessToken, clientId});
            return response.data.length > 0;
        } catch (error) {
            if (HttpError.statusOf(error) === 400) return false;

            this.logger.warning("AUTH", `Could not verify bot user ${botUserId} of application ${clientId}, storing it unverified`);
            this.errorReporter.handle(error, {clientId, botUserId});
            return true;
        }
    }

    /** Conduit, then the authorization subscriptions (once), then the subscriptions of every known user. */
    private async runSetup(clientId: string, credentials: ClientCredentials): Promise<AppSetupResult | null> {
        let app: App = await this.appStore.findOrCreate(clientId);

        const conduit: EventSubConduitResult | null = await this.eventSubConduitManager.ensureConduit(app, credentials.accessToken);
        if (!conduit) return null;

        // A new conduit has no subscriptions yet – they are all created again below.
        if (conduit.created) {
            const updated: App | null = await this.appStore.update(clientId, {conduitId: conduit.conduitId, hasAuthorizationSubscriptions: false});
            if (!updated) return null;
            app = updated;
        // Everything was set up before – nothing to do on a normal IDENTIFY.
        } else if (app.hasAuthorizationSubscriptions) {
            return {app, restoredOnNewConduit: false};
        }

        const subscriptions: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.appSubscriptions(
            app.clientId,
            {
                method: EventSubTransportMethod.Conduit,
                conduit_id: conduit.conduitId,
            },
        );

        const created: boolean = await this.eventSubSubscriptionManager.subscribe(subscriptions, credentials.accessToken, app.clientId);
        if (!created) return null;

        app = await this.appStore.update(clientId, {hasAuthorizationSubscriptions: true}) ?? app;

        await this.eventSubSubscriptionManager.restoreUserSubscriptions(app, credentials.accessToken);

        return {app, restoredOnNewConduit: conduit.created};
    }
}
