import type {EventSubSubscription, RESTPostEventSubSubscriptionRequestBody, RESTPostEventSubSubscriptionResponse} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore, PublicSubscription} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import type {EventSubScopeService, PublicSubscriptionRequest} from "@twitch/eventsub/EventSubScopeService.ts";
import type {EventSubSubscriptionManager, RestoredUsers, SubscriptionFailure} from "@twitch/eventsub/EventSubSubscriptionManager.ts";

/** Result of POST /twitch/subscriptions. */
export type PublicSubscribeResult =
    | {status: "created"; subscription: EventSubSubscription | null}
    | {status: "exists"}
    | {status: "failed"; httpStatus: number | null; message: string};

/** Result of DELETE /twitch/subscriptions – `kept`: the gateway still needs it for an authorized user. */
export type PublicUnsubscribeResult = "deleted" | "kept" | "not_found" | "failed";

/**
 * The public subscriptions an app requested with POST /twitch/subscriptions (types without authorization, any channel):
 * creates and deletes them, remembers them in Redis and creates them again on every new conduit.
 */
@Bean()
export class EventSubPublicSubscriptionManager {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private eventSubSubscriptionManager!: EventSubSubscriptionManager;

    @Autowired()
    private eventSubLimitService!: EventSubLimitService;

    @Autowired()
    private logger!: Logger;

    /** Creates a public subscription on the app's conduit and remembers it, so every new conduit gets it again. */
    public async createPublicSubscription(app: App, accessToken: string, request: PublicSubscriptionRequest): Promise<PublicSubscribeResult> {
        if (!app.conduitId) return {status: "failed", httpStatus: null, message: "The application has no conduit"};

        const body: RESTPostEventSubSubscriptionRequestBody = this.eventSubScopeService.conduitRequest(request, app.conduitId);
        const key: string = this.eventSubScopeService.subscriptionKey(body);
        const record: PublicSubscription = {...request, createdAt: Date.now()};

        try {
            const response: RESTPostEventSubSubscriptionResponse = await this.twitchClient.createSubscription(body, {accessToken, clientId: app.clientId});
            this.eventSubLimitService.record(app.clientId, response);
            await this.appStore.addPublicSubscription(app.clientId, key, record);

            this.logger.success("EVENTSUB", "Subscribed (public)", {app: app.clientId, type: request.type, condition: request.condition});
            return {status: "created", subscription: response.data[0] ?? null};
        } catch (error) {
            // Already on the conduit (e.g. stream.online of an authorized user) – remember it anyway.
            if (HttpError.statusOf(error) === 409) {
                await this.appStore.addPublicSubscription(app.clientId, key, record);
                return {status: "exists"};
            }

            const failure: SubscriptionFailure = this.eventSubSubscriptionManager.describeFailure(body, error);
            this.logger.warn("EVENTSUB", "Subscribe (public) failed", {app: app.clientId, type: request.type, condition: request.condition}, error);
            return {status: "failed", httpStatus: failure.status, message: failure.message};
        }
    }

    /** Deletes a public subscription the app requested – unless the gateway needs it for an authorized user. */
    public async deletePublicSubscription(app: App, accessToken: string, request: PublicSubscriptionRequest): Promise<PublicUnsubscribeResult> {
        const key: string = this.eventSubScopeService.subscriptionKey(request);
        const requested: boolean = (await this.appStore.getPublicSubscriptions(app.clientId))
            .some((sub: PublicSubscription): boolean => this.eventSubScopeService.subscriptionKey(sub) === key);
        if (!requested) return "not_found";

        // Every public type has exactly one user in its condition.
        const userId: string = Object.values(request.condition)[0];
        if (this.eventSubScopeService.isCreatedForAuthorizedUsers(request.type) && (await this.appStore.getAuthorizedUsers(app.clientId)).includes(userId)) {
            await this.appStore.removePublicSubscription(app.clientId, key);
            return "kept";
        }

        const subs: EventSubSubscription[] | null = await this.eventSubSubscriptionManager.getSubscriptions(accessToken, app.clientId, {user_id: userId});
        if (!subs) return "failed";

        for (const sub of subs) {
            if (!this.eventSubScopeService.isOnConduit(sub, app.conduitId) || this.eventSubScopeService.subscriptionKey(sub) !== key) continue;
            if (!await this.eventSubSubscriptionManager.unsubscribe(sub, accessToken, app.clientId)) return "failed";
        }

        await this.appStore.removePublicSubscription(app.clientId, key);
        this.logger.success("EVENTSUB", "Unsubscribed (public)", {app: app.clientId, type: request.type, condition: request.condition});
        return "deleted";
    }

    /** Twitch revoked a subscription – a public one is forgotten, the app may request it again. */
    public async forgetPublicSubscription(clientId: string, sub: Pick<EventSubSubscription, "type" | "version" | "condition">): Promise<void> {
        if (await this.appStore.removePublicSubscription(clientId, this.eventSubScopeService.subscriptionKey(sub))) {
            this.logger.info("EVENTSUB", "Revoked public subscription forgotten", {app: clientId, type: sub.type, condition: sub.condition});
        }
    }

    /**
     * After the users were restored: creates the requested subscriptions that aren't on the conduit (all of them if the
     * list is unknown – 409 is fine), and takes over those of an orphaned conduit.
     */
    public async restorePublicSubscriptions(app: App, accessToken: string, restored: RestoredUsers): Promise<void> {
        if (!app.conduitId) return;

        const existingKeys: Set<string> = new Set<string>((restored.existingSubs ?? [])
            .filter((sub: EventSubSubscription): boolean => this.eventSubScopeService.isOnConduit(sub, app.conduitId))
            .map((sub: EventSubSubscription): string => this.eventSubScopeService.subscriptionKey(sub)));
        const conduitId: string = app.conduitId;
        const missing: RESTPostEventSubSubscriptionRequestBody[] = restored.publicSubs
            .map((sub: PublicSubscription): RESTPostEventSubSubscriptionRequestBody => this.eventSubScopeService.conduitRequest(sub, conduitId))
            .filter((sub: RESTPostEventSubSubscriptionRequestBody): boolean => !existingKeys.has(this.eventSubScopeService.subscriptionKey(sub)));

        if (missing.length > 0) {
            this.logger.info("EVENTSUB", "Restoring public subscriptions", {app: app.clientId, count: missing.length});
            await this.eventSubSubscriptionManager.subscribe(missing, accessToken, app.clientId);
        }

        await this.adoptPublicSubscriptions(app, accessToken, restored);
    }

    /** Public subscriptions of an orphaned conduit: public types of users that never authorized the app – requested by it. */
    private async adoptPublicSubscriptions(app: App, accessToken: string, restored: RestoredUsers): Promise<void> {
        if (!app.conduitId) return;

        const knownKeys: Set<string> = new Set<string>(restored.publicSubs.map((sub: PublicSubscription): string => this.eventSubScopeService.subscriptionKey(sub)));
        const adopted: RESTPostEventSubSubscriptionRequestBody[] = [];
        for (const sub of restored.adoptedSubs) {
            const key: string = this.eventSubScopeService.subscriptionKey(sub);
            const userId: string | null = this.eventSubScopeService.getConditionUserId(sub);
            if (knownKeys.has(key) || !userId || !restored.unauthorized.has(userId)) continue;
            if (!this.eventSubScopeService.checkPublicSubscription({type: sub.type, version: sub.version, condition: sub.condition}).valid) continue;

            knownKeys.add(key);
            await this.appStore.addPublicSubscription(app.clientId, key, {type: sub.type, version: sub.version, condition: sub.condition as Record<string, string>, createdAt: Date.now()});
            adopted.push(this.eventSubScopeService.conduitRequest(sub, app.conduitId));
        }
        if (adopted.length === 0) return;

        this.logger.info("EVENTSUB", "Taking over public subscriptions of an orphaned conduit", {app: app.clientId, count: adopted.length});
        await this.eventSubSubscriptionManager.subscribe(adopted, accessToken, app.clientId);
    }
}
