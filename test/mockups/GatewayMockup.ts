import {spyOn, type Mock} from "bun:test";
import type {BunRequest} from "bun";
import type {ConfigValues} from "@core/config/ConfigManager.ts";
import {HttpClient} from "@core/http/HttpClient.ts";
import {HttpProxyService} from "@core/http/HttpProxyService.ts";
import {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import {TwitchClient} from "@twitch/TwitchClient.ts";
import {AppAuthenticator, type AppCredentialsResult} from "@twitch/app/AppAuthenticator.ts";
import {AppCleanupService} from "@twitch/app/AppCleanupService.ts";
import {AppSetupService, type BotUserUpdate} from "@twitch/app/AppSetupService.ts";
import {AppStore, type App} from "@twitch/app/AppStore.ts";
import {EventSubConduitManager} from "@twitch/eventsub/EventSubConduitManager.ts";
import {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import {EventSubMessageHandler} from "@twitch/eventsub/EventSubMessageHandler.ts";
import {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";
import {EventSubSubscriptionController} from "@twitch/eventsub/EventSubSubscriptionController.ts";
import {EventSubSubscriptionManager} from "@twitch/eventsub/EventSubSubscriptionManager.ts";
import {EventSubWebhookController} from "@twitch/eventsub/EventSubWebhookController.ts";
import {EventSubWebhookStore} from "@twitch/eventsub/EventSubWebhookStore.ts";
import {loadConfig, provideBean} from "../helpers.ts";
import {ConfigManagerMockup} from "./ConfigManagerMockup.ts";
import {LoggerMockup} from "./LoggerMockup.ts";
import {RedisClientMockup} from "./RedisClientMockup.ts";
import {TwitchMockup} from "./TwitchMockup.ts";

/** An event the gateway handed to the sessions of an app. */
export interface Dispatched {
    app: string;
    event: string;
    data: unknown;
}

/**
 * Everything of the gateway that talks to Twitch, wired with fresh beans against a TwitchMockup: real HTTP client,
 * Twitch client, conduit and subscription managers, webhook controller and message handler. Stand-ins only where
 * Redis or sockets would be needed: the stores use RedisClientMockup, dispatches are recorded, sessions are a set.
 */
export class GatewayMockup {
    public readonly twitch: TwitchMockup;
    public readonly logger: LoggerMockup = new LoggerMockup();
    public readonly redis: RedisClientMockup = new RedisClientMockup();
    public readonly dispatched: Dispatched[] = [];
    // Apps with a connected or resumable session (for the inactivity cleanup).
    public readonly appsWithSessions: Set<string> = new Set<string>();

    public readonly appStore: AppStore = new AppStore();
    public readonly appAuthenticator: AppAuthenticator = new AppAuthenticator();
    public readonly appSetupService: AppSetupService = new AppSetupService();
    public readonly appCleanupService: AppCleanupService = new AppCleanupService();
    public readonly subscriptionManager: EventSubSubscriptionManager = new EventSubSubscriptionManager();
    public readonly limitService: EventSubLimitService = new EventSubLimitService();
    public readonly webhookController: EventSubWebhookController = new EventSubWebhookController();
    public readonly subscriptionController: EventSubSubscriptionController = new EventSubSubscriptionController();

    private readonly fetchSpy: Mock<typeof fetch>;

    /** `twitch` of an earlier GatewayMockup simulates a restart: same Twitch, fresh process and an empty Redis. */
    public constructor(env: Record<string, string | undefined> = {}, twitch: TwitchMockup = new TwitchMockup()) {
        this.twitch = twitch;
        const config: ConfigValues = loadConfig(env);
        const beans: Record<string, object> = {
            configManager: new ConfigManagerMockup(config),
            logger: this.logger,
            redisClient: this.redis,
            httpClient: new HttpClient(),
            httpProxyService: new HttpProxyService(),
            connectionLimitManager: new ConnectionLimitManager(),
            twitchClient: new TwitchClient(),
            appStore: this.appStore,
            appAuthenticator: this.appAuthenticator,
            appSetupService: this.appSetupService,
            eventSubWebhookStore: new EventSubWebhookStore(),
            eventSubScopeService: new EventSubScopeService(),
            eventSubLimitService: this.limitService,
            eventSubConduitManager: new EventSubConduitManager(),
            eventSubSubscriptionManager: this.subscriptionManager,
            eventSubMessageHandler: new EventSubMessageHandler(),
            sessionDispatcher: {
                dispatch: (app: string, event: string, data: unknown): void => {
                    this.dispatched.push({app, event, data});
                },
            },
            sessionStore: {hasSessions: async (app: string): Promise<boolean> => this.appsWithSessions.has(app)},
        };
        // Every bean resolves its @Autowired fields on first access – so all of them are registered before any use.
        for (const [token, bean] of Object.entries(beans)) provideBean(token, bean);

        this.twitch.deliverTo((request: Request): Promise<Response> => this.webhookController.handleCallback(request as BunRequest));
        this.fetchSpy = spyOn(globalThis, "fetch").mockImplementation(this.twitch.fetch as typeof fetch);
    }

    /** The Twitch part of an IDENTIFY: check the credentials, store the bot user, set up the app. */
    public async identify(clientId: string, clientSecret: string, botUserId?: string | null): Promise<App | null> {
        const result: AppCredentialsResult = await this.appAuthenticator.getCredentials(clientId, clientSecret);
        if (result.status !== "valid") throw new Error(`IDENTIFY failed: ${result.status}`);

        const botUser: BotUserUpdate | null = await this.appSetupService.updateBotUser(clientId, botUserId, result.credentials.accessToken);
        if (!botUser) throw new Error("IDENTIFY failed: unknown botUserId");
        return await this.appSetupService.setupApplication(clientId, result.credentials, botUser);
    }

    /** Events dispatched to an app, by name. */
    public events(app: string, event?: string): Dispatched[] {
        return this.dispatched.filter((entry: Dispatched): boolean => entry.app === app && (!event || entry.event === event));
    }

    /** Waits until the background work after a webhook (grant, revoke, reconcile) reached a state. */
    public async waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number = 2000): Promise<void> {
        const until: number = Date.now() + timeoutMs;
        while (!await condition()) {
            if (Date.now() > until) throw new Error("waitFor timed out");
            await Bun.sleep(5);
        }
    }

    /** Puts the real fetch back. */
    public dispose(): void {
        this.fetchSpy.mockRestore();
    }
}
