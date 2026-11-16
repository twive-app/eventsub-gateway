import {
    EventSubSubscriptionStatus,
    EventSubSubscriptionType,
    EventSubTransportMethod,
    type EventSubSubscription,
    type RESTGetAuthorizationByUserResponse,
    type RESTPostEventSubSubscriptionRequestBody,
    type RESTPostEventSubSubscriptionResponse,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {GatewayDispatchEvent} from "@gateway/GatewayProtocol.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import type {TwitchSubscriptionFilter, TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore, PublicSubscription} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import type {EventSubScopeService, PublicSubscriptionRequest} from "@twitch/eventsub/EventSubScopeService.ts";

// Subscriptions that count as existing – revoked or failed ones are created again.
const activeStatuses: Set<EventSubSubscriptionStatus> = new Set<EventSubSubscriptionStatus>([
    EventSubSubscriptionStatus.Enabled,
    EventSubSubscriptionStatus.WebhookCallbackVerificationPending,
]);

// Twitch's maximum of user ids per Get Authorization By User request.
const authorizationBatchSize: number = 10;

// Condition fields that name the user a subscription belongs to.
const userConditionFields: string[] = ["broadcaster_user_id", "to_broadcaster_user_id", "user_id"];

/** Data of SUBSCRIPTION_FAILED: the subscription that couldn't be created and why. */
interface SubscriptionFailure {
    type: string;
    version: string;
    condition: RESTPostEventSubSubscriptionRequestBody["condition"];
    // HTTP status of Twitch's answer – null if Twitch wasn't reachable.
    status: number | null;
    message: string;
}

/** Result of POST /twitch/subscriptions. */
export type PublicSubscribeResult =
    | {status: "created"; subscription: EventSubSubscription | null}
    | {status: "exists"}
    | {status: "failed"; httpStatus: number | null; message: string};

/** Result of DELETE /twitch/subscriptions – `kept`: the gateway still needs it for an authorized user. */
export type PublicUnsubscribeResult = "deleted" | "kept" | "not_found" | "failed";

/** Transport of a subscription as Twitch returns it. */
interface SubscriptionTransport {
    method: string;
    conduit_id?: string;
}

/** Creates and syncs the EventSub subscriptions on the app's conduit – per user and for the bot. */
@Bean()
export class EventSubSubscriptionManager {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    @Autowired()
    private eventSubLimitService!: EventSubLimitService;

    @Autowired()
    private logger!: Logger;

    // One bot reconcile per app at a time; a change during a run queues exactly one more run.
    private readonly reconcileRuns: Map<string, Promise<void>> = new Map<string, Promise<void>>();
    private readonly reconcileQueue: Map<string, string> = new Map<string, string>();

    /** Creates subscriptions, 409 counts as success; false if any failed (each one is sent as SUBSCRIPTION_FAILED). */
    public async subscribe(subs: RESTPostEventSubSubscriptionRequestBody[], accessToken: string, clientId: string): Promise<boolean> {
        let success: boolean = true;
        const created: string[] = [];

        for (const sub of subs) {
            try {
                const response: RESTPostEventSubSubscriptionResponse = await this.twitchClient.createSubscription(sub, {accessToken, clientId});
                this.eventSubLimitService.record(clientId, response);
                created.push(sub.type);
                this.logger.debug("EVENTSUB", "Subscribed", {app: clientId, type: sub.type, user: this.getConditionUserId(sub)});
            } catch (error) {
                if (HttpError.statusOf(error) === 409) {
                    this.logger.debug("EVENTSUB", "Already subscribed", {app: clientId, type: sub.type, user: this.getConditionUserId(sub)});
                    continue;
                }

                success = false;
                this.logger.warn("EVENTSUB", "Subscribe failed", {app: clientId, type: sub.type, condition: sub.condition}, error);
                this.sessionDispatcher.dispatch(clientId, GatewayDispatchEvent.SubscriptionFailed, this.describeFailure(sub, error));
            }
        }

        // One line per user instead of one per subscription – the types only while they fit (all of them with LOG_DEBUG).
        if (created.length > 0) {
            const user: string | null = subs[0] ? this.getConditionUserId(subs[0]) : null;
            this.logger.success("EVENTSUB", "Subscribed", {app: clientId, user, count: created.length, types: created.length <= 3 ? created : undefined});
        }
        return success;
    }

    /** Creates a public subscription on the app's conduit and remembers it, so every new conduit gets it again. */
    public async createPublicSubscription(app: App, accessToken: string, request: PublicSubscriptionRequest): Promise<PublicSubscribeResult> {
        if (!app.conduitId) return {status: "failed", httpStatus: null, message: "The application has no conduit"};

        const body: RESTPostEventSubSubscriptionRequestBody = {
            ...request,
            transport: {method: EventSubTransportMethod.Conduit, conduit_id: app.conduitId},
        } as RESTPostEventSubSubscriptionRequestBody;
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

            const failure: SubscriptionFailure = this.describeFailure(body, error);
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

        const subs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, app.clientId, {user_id: userId});
        if (!subs) return "failed";

        for (const sub of subs) {
            if (!this.isOnConduit(sub, app.conduitId) || this.eventSubScopeService.subscriptionKey(sub) !== key) continue;
            if (!await this.unsubscribe(sub, accessToken, app.clientId)) return "failed";
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

    /** What the app learns about a failed subscription – Twitch's own message, never our request details. */
    private describeFailure(sub: RESTPostEventSubSubscriptionRequestBody, error: unknown): SubscriptionFailure {
        const status: number | null = HttpError.statusOf(error);
        const body: unknown = error instanceof HttpError ? error.body : null;
        const twitchMessage: unknown = typeof body === "object" && body !== null ? (body as Record<string, unknown>).message : null;

        let message: string;
        if (typeof twitchMessage === "string" && twitchMessage.length > 0) message = twitchMessage;
        else if (status !== null) message = `Twitch answered with status ${status}`;
        else message = "Twitch could not be reached";

        return {type: sub.type, version: sub.version, condition: sub.condition, status, message};
    }

    /** Active subscriptions of the app matching the filter; null if Twitch fails. */
    private async getSubscriptions(accessToken: string, clientId: string, filter: TwitchSubscriptionFilter = {}): Promise<EventSubSubscription[] | null> {
        let subscriptions: EventSubSubscription[];
        try {
            subscriptions = await this.twitchClient.getSubscriptions({accessToken, clientId}, filter);
        } catch (error) {
            this.logger.error("EVENTSUB", "Could not list the subscriptions", {app: clientId, user: filter.user_id}, error);
            return null;
        }

        return subscriptions.filter((sub: EventSubSubscription): boolean => activeStatuses.has(sub.status));
    }

    /** Subscribes a user to everything the granted scopes allow that isn't on the conduit yet (after a grant). */
    public async syncUserSubscriptions(app: App, accessToken: string, userId: string): Promise<boolean> {
        if (!app.conduitId) return false;

        const authorizations: Map<string, string[]> | null = await this.getAuthorizations(app, accessToken, [userId]);
        const scopes: string[] | undefined = authorizations?.get(userId);
        if (!scopes) return false;

        return await this.subscribeUser(app, accessToken, userId, scopes, null);
    }

    /** Scopes per user (up to 10 per request); users without an authorization are missing, null if Twitch failed. */
    private async getAuthorizations(app: App, accessToken: string, userIds: string[]): Promise<Map<string, string[]> | null> {
        let response: RESTGetAuthorizationByUserResponse;
        try {
            response = await this.twitchClient.getAuthorizations(userIds, {accessToken, clientId: app.clientId});
        } catch (error) {
            this.logger.error("EVENTSUB", "Could not get the granted scopes", {app: app.clientId, users: userIds}, error);
            return null;
        }

        return new Map<string, string[]>(response.data.map((authorization: RESTGetAuthorizationByUserResponse["data"][number]): [string, string[]] => [
            authorization.user_id,
            authorization.scopes,
        ]));
    }

    /**
     * Creates what the scopes allow and isn't on the conduit yet. `knownSubs` (all active subscriptions of the app, e.g.
     * from a restore) saves the request for the user's subscriptions; null asks Twitch.
     */
    private async subscribeUser(app: App, accessToken: string, userId: string, scopes: string[], knownSubs: EventSubSubscription[] | null): Promise<boolean> {
        if (!app.conduitId) return false;

        // user_id matches every condition field, so this also finds the bot chat subscriptions of the channel.
        const userSubs: EventSubSubscription[] | null = knownSubs
            ? knownSubs.filter((sub: EventSubSubscription): boolean => this.hasConditionUser(sub, userId))
            : await this.getSubscriptions(accessToken, app.clientId, {user_id: userId});
        if (!userSubs) return false;

        const existingSubs: EventSubSubscription[] = userSubs.filter((sub: EventSubSubscription): boolean => this.isOnConduit(sub, app.conduitId));
        const subs: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.forUser(
            scopes,
            app.botUserId,
            userId,
            {
                method: EventSubTransportMethod.Conduit,
                conduit_id: app.conduitId,
            },
            existingSubs,
        );

        await this.addAuthorizedUsers(app.clientId, userId);
        return await this.subscribe(subs, accessToken, app.clientId);
    }

    /** Syncs every known user (stored ones plus those found on the conduit, e.g. after Redis lost them) and the public subscriptions. */
    public async restoreUserSubscriptions(app: App, accessToken: string): Promise<void> {
        const userIds: Set<string> = new Set<string>(await this.appStore.getAuthorizedUsers(app.clientId));

        const existingSubs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, app.clientId);
        const publicSubs: PublicSubscription[] = await this.appStore.getPublicSubscriptions(app.clientId);
        const publicKeys: Set<string> = new Set<string>(publicSubs.map((sub: PublicSubscription): string => this.eventSubScopeService.subscriptionKey(sub)));

        for (const sub of existingSubs ?? []) {
            if (!this.isOnConduit(sub, app.conduitId)) continue;
            // A public subscription doesn't mean its user authorized the app.
            if (publicKeys.has(this.eventSubScopeService.subscriptionKey(sub))) continue;

            const userId: string | null = this.getConditionUserId(sub);
            if (userId) userIds.add(userId);
        }

        await this.restorePublicSubscriptions(app, accessToken, publicSubs, existingSubs);
        if (userIds.size === 0) return;

        this.logger.info("EVENTSUB", "Restoring user subscriptions", {app: app.clientId, users: userIds.size});
        // One subscription list for all users and the scopes of 10 users per request, not two requests per user.
        // If the list failed, every user asks for its own subscriptions.
        const ids: string[] = [...userIds];
        for (let start: number = 0; start < ids.length; start += authorizationBatchSize) {
            const batch: string[] = ids.slice(start, start + authorizationBatchSize);
            const authorizations: Map<string, string[]> | null = await this.getAuthorizations(app, accessToken, batch);
            if (!authorizations) continue;

            for (const userId of batch) {
                // Missing = the user no longer authorizes the app – nothing to restore.
                const scopes: string[] | undefined = authorizations.get(userId);
                if (scopes) await this.subscribeUser(app, accessToken, userId, scopes, existingSubs);
            }
        }
    }

    /** Creates the public subscriptions that aren't on the conduit (all of them if the list is unknown – 409 is fine). */
    private async restorePublicSubscriptions(app: App, accessToken: string, publicSubs: PublicSubscription[], existingSubs: EventSubSubscription[] | null): Promise<void> {
        if (!app.conduitId || publicSubs.length === 0) return;

        const transport: {method: EventSubTransportMethod.Conduit; conduit_id: string} = {method: EventSubTransportMethod.Conduit, conduit_id: app.conduitId};
        const existingKeys: Set<string> = new Set<string>((existingSubs ?? [])
            .filter((sub: EventSubSubscription): boolean => this.isOnConduit(sub, app.conduitId))
            .map((sub: EventSubSubscription): string => this.eventSubScopeService.subscriptionKey(sub)));

        const missing: RESTPostEventSubSubscriptionRequestBody[] = publicSubs
            .map((sub: PublicSubscription): RESTPostEventSubSubscriptionRequestBody => ({type: sub.type, version: sub.version, condition: sub.condition, transport}) as RESTPostEventSubSubscriptionRequestBody)
            .filter((sub: RESTPostEventSubSubscriptionRequestBody): boolean => !existingKeys.has(this.eventSubScopeService.subscriptionKey(sub)));
        if (missing.length === 0) return;

        this.logger.info("EVENTSUB", "Restoring public subscriptions", {app: app.clientId, count: missing.length});
        await this.subscribe(missing, accessToken, app.clientId);
    }

    /** Moves the bot chat subscriptions to the current bot – runs once per app at a time, changes are queued. */
    public reconcileBotSubscriptions(clientId: string, accessToken: string): Promise<void> {
        const running: Promise<void> | undefined = this.reconcileRuns.get(clientId);
        if (running) {
            this.reconcileQueue.set(clientId, accessToken);
            return running;
        }

        const run: Promise<void> = this.runReconcile(clientId, accessToken).finally((): void => {
            this.reconcileRuns.delete(clientId);
        });
        this.reconcileRuns.set(clientId, run);
        return run;
    }

    /** Repeats the reconcile until no change is queued any more. */
    private async runReconcile(clientId: string, accessToken: string): Promise<void> {
        let next: string | undefined = accessToken;
        while (next !== undefined) {
            this.reconcileQueue.delete(clientId);
            try {
                await this.reconcileOnce(clientId, next);
            } catch (error) {
                this.logger.error("EVENTSUB", "Could not move the bot chat subscriptions", {app: clientId}, error);
            }
            next = this.reconcileQueue.get(clientId);
        }
    }

    /** Deletes bot chat subscriptions of any other bot on the conduit, then creates the missing ones. */
    private async reconcileOnce(clientId: string, accessToken: string): Promise<void> {
        // Read fresh: the bot may have changed again since the run was queued.
        const app: App | null = await this.appStore.find(clientId);
        if (!app?.conduitId) return;

        this.logger.info("EVENTSUB", "Moving the bot chat subscriptions to the current bot", {app: clientId, bot: app.botUserId ?? "none"});

        const subs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, clientId);
        if (!subs) return;

        let removed: number = 0;
        for (const sub of subs) {
            if (!this.isOnConduit(sub, app.conduitId)) continue;

            const botUserId: string | null = this.eventSubScopeService.getBotUserId(sub);
            if (botUserId !== null && botUserId !== app.botUserId && await this.unsubscribe(sub, accessToken, clientId)) removed++;
        }
        if (removed > 0) this.logger.success("EVENTSUB", "Chat subscriptions of the previous bot removed", {app: clientId, count: removed});

        await this.restoreUserSubscriptions(app, accessToken);
    }

    /** Deletes a subscription; already gone (404) is fine. False if Twitch failed. */
    private async unsubscribe(sub: EventSubSubscription, accessToken: string, clientId: string): Promise<boolean> {
        try {
            await this.twitchClient.deleteSubscription(sub.id, {accessToken, clientId});
            this.logger.debug("EVENTSUB", "Unsubscribed", {app: clientId, type: sub.type, id: sub.id});
            return true;
        } catch (error) {
            if (HttpError.statusOf(error) === 404) return true;

            this.logger.warn("EVENTSUB", "Unsubscribe failed", {app: clientId, type: sub.type, id: sub.id}, error);
            return false;
        }
    }

    /** Stores authorized users; a Redis failure is only logged (the conduit still knows them). */
    private async addAuthorizedUsers(clientId: string, ...userIds: string[]): Promise<void> {
        try {
            await this.appStore.addAuthorizedUsers(clientId, ...userIds);
        } catch (error) {
            this.logger.warn("EVENTSUB", "Could not store the authorized users", {app: clientId, users: userIds}, error);
        }
    }

    /** Whether a subscription is on the given conduit (and not on a transport of the developer). */
    private isOnConduit(sub: EventSubSubscription, conduitId: string | null): boolean {
        const transport: SubscriptionTransport = sub.transport as SubscriptionTransport;
        return transport.method === EventSubTransportMethod.Conduit && transport.conduit_id === conduitId;
    }

    /** Whether a user id is in any condition field – what Twitch's user_id filter matches. */
    private hasConditionUser(sub: EventSubSubscription, userId: string): boolean {
        return Object.values(sub.condition as Record<string, unknown>).includes(userId);
    }

    /** The user a subscription belongs to – null for the app-wide authorization subscriptions. */
    private getConditionUserId(sub: {type: string; condition: object}): string | null {
        if (
            sub.type === EventSubSubscriptionType.UserAuthorizationGrant ||
            sub.type === EventSubSubscriptionType.UserAuthorizationRevoke
        ) return null;

        const condition: Record<string, string | undefined> = sub.condition as Record<string, string | undefined>;
        for (const field of userConditionFields) {
            if (condition[field]) return condition[field];
        }
        return null;
    }
}
