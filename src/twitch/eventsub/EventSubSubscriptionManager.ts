import {
    EventSubSubscriptionStatus,
    EventSubSubscriptionType,
    EventSubTransportMethod,
    type EventSubSubscription,
    type RESTGetAuthorizationByUserResponse,
    type RESTPostEventSubSubscriptionRequestBody,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {TwitchSubscriptionFilter, TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";

// Subscriptions that count as existing – revoked or failed ones are created again.
const activeStatuses: Set<EventSubSubscriptionStatus> = new Set<EventSubSubscriptionStatus>([
    EventSubSubscriptionStatus.Enabled,
    EventSubSubscriptionStatus.WebhookCallbackVerificationPending,
]);

// Condition fields that name the user a subscription belongs to.
const userConditionFields: string[] = ["broadcaster_user_id", "to_broadcaster_user_id", "user_id"];

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
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    // One bot reconcile per app at a time; a change during a run queues exactly one more run.
    private readonly reconcileRuns: Map<string, Promise<void>> = new Map<string, Promise<void>>();
    private readonly reconcileQueue: Map<string, string> = new Map<string, string>();

    /** Creates subscriptions; an existing one (409) counts as success. False if any failed. */
    public async subscribe(subs: RESTPostEventSubSubscriptionRequestBody[], accessToken: string, clientId: string): Promise<boolean> {
        let success: boolean = true;

        for (const sub of subs) {
            try {
                await this.twitchClient.createSubscription(sub, {accessToken, clientId});
                this.logger.success("EVENTSUB", `Subscribed to ${sub.type} for application with client id ${clientId}`);
            } catch (error) {
                if (HttpError.statusOf(error) === 409) {
                    this.logger.debug("EVENTSUB", `Subscription ${sub.type} already exists for application with client id ${clientId}`);
                    continue;
                }

                success = false;
                this.logger.error("EVENTSUB", `Failed to subscribe to ${sub.type} for application with client id ${clientId}`);
                this.errorReporter.handle(error, {clientId, type: sub.type, condition: sub.condition});
            }
        }

        return success;
    }

    /** Active subscriptions of the app matching the filter; null if Twitch fails. */
    private async getSubscriptions(accessToken: string, clientId: string, filter: TwitchSubscriptionFilter = {}): Promise<EventSubSubscription[] | null> {
        let subscriptions: EventSubSubscription[];
        try {
            subscriptions = await this.twitchClient.getSubscriptions({accessToken, clientId}, filter);
        } catch (error) {
            this.logger.error("EVENTSUB", `Failed to get subscriptions for application with client id ${clientId}`);
            this.errorReporter.handle(error, {clientId});
            return null;
        }

        return subscriptions.filter((sub: EventSubSubscription): boolean => activeStatuses.has(sub.status));
    }

    /** Subscribes a user to everything the granted scopes allow that isn't on the conduit yet. */
    public async syncUserSubscriptions(app: App, accessToken: string, userId: string): Promise<boolean> {
        if (!app.conduitId) return false;

        let authorizedUserResponse: RESTGetAuthorizationByUserResponse;
        try {
            authorizedUserResponse = await this.twitchClient.getAuthorization(userId, {accessToken, clientId: app.clientId});
        } catch (error) {
            this.logger.error("EVENTSUB", `Failed to obtain scopes for user with id ${userId}`);
            this.errorReporter.handle(error, {clientId: app.clientId, userId});
            return false;
        }

        const authorization: RESTGetAuthorizationByUserResponse["data"][number] | undefined = authorizedUserResponse.data[0];
        if (!authorization) return false;

        // user_id matches every condition field, so this also finds the bot chat subscriptions of the channel.
        const userSubs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, app.clientId, {user_id: userId});
        if (!userSubs) return false;

        const existingSubs: EventSubSubscription[] = userSubs.filter((sub: EventSubSubscription): boolean => this.isOnConduit(sub, app.conduitId));
        const subs: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.forUser(
            authorization.scopes,
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

    /** Syncs every known user – the stored ones plus those found on the conduit (e.g. after Redis lost them). */
    public async restoreUserSubscriptions(app: App, accessToken: string): Promise<void> {
        const userIds: Set<string> = new Set<string>(await this.appStore.getAuthorizedUsers(app.clientId));

        const existingSubs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, app.clientId);
        for (const sub of existingSubs ?? []) {
            if (!this.isOnConduit(sub, app.conduitId)) continue;

            const userId: string | null = this.getConditionUserId(sub);
            if (userId) userIds.add(userId);
        }

        if (userIds.size === 0) return;

        this.logger.info("EVENTSUB", `Restoring subscriptions of ${userIds.size} user(s) for application ${app.clientId}`);
        for (const userId of userIds) {
            await this.syncUserSubscriptions(app, accessToken, userId);
        }
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
                this.logger.error("EVENTSUB", `Failed to reconcile the bot chat subscriptions of application ${clientId}`);
                this.errorReporter.handle(error, {clientId});
            }
            next = this.reconcileQueue.get(clientId);
        }
    }

    /** Deletes bot chat subscriptions of any other bot on the conduit, then creates the missing ones. */
    private async reconcileOnce(clientId: string, accessToken: string): Promise<void> {
        // Read fresh: the bot may have changed again since the run was queued.
        const app: App | null = await this.appStore.find(clientId);
        if (!app?.conduitId) return;

        this.logger.info("EVENTSUB", `Reconciling the bot chat subscriptions of application ${clientId} (bot user ${app.botUserId ?? "none"})`);

        const subs: EventSubSubscription[] | null = await this.getSubscriptions(accessToken, clientId);
        if (!subs) return;

        for (const sub of subs) {
            if (!this.isOnConduit(sub, app.conduitId)) continue;

            const botUserId: string | null = this.eventSubScopeService.getBotUserId(sub);
            if (botUserId !== null && botUserId !== app.botUserId) await this.unsubscribe(sub, accessToken, clientId);
        }

        await this.restoreUserSubscriptions(app, accessToken);
    }

    /** Deletes a subscription; already gone (404) is fine. */
    private async unsubscribe(sub: EventSubSubscription, accessToken: string, clientId: string): Promise<void> {
        try {
            await this.twitchClient.deleteSubscription(sub.id, {accessToken, clientId});
            this.logger.info("EVENTSUB", `Unsubscribed from ${sub.type} (${sub.id}) for application with client id ${clientId}`);
        } catch (error) {
            if (HttpError.statusOf(error) === 404) return;

            this.logger.error("EVENTSUB", `Failed to unsubscribe from ${sub.type} (${sub.id}) for application with client id ${clientId}`);
            this.errorReporter.handle(error, {clientId, type: sub.type, condition: sub.condition});
        }
    }

    /** Stores authorized users; a Redis failure is only logged (the conduit still knows them). */
    private async addAuthorizedUsers(clientId: string, ...userIds: string[]): Promise<void> {
        try {
            await this.appStore.addAuthorizedUsers(clientId, ...userIds);
        } catch (error) {
            this.logger.warning("EVENTSUB", `Could not store authorized user(s) ${userIds.join(", ")} of application ${clientId}`);
            this.errorReporter.handle(error, {clientId});
        }
    }

    /** Whether a subscription is on the given conduit (and not on a transport of the developer). */
    private isOnConduit(sub: EventSubSubscription, conduitId: string | null): boolean {
        const transport: SubscriptionTransport = sub.transport as SubscriptionTransport;
        return transport.method === EventSubTransportMethod.Conduit && transport.conduit_id === conduitId;
    }

    /** The user a subscription belongs to – null for the app-wide authorization subscriptions. */
    private getConditionUserId(sub: EventSubSubscription): string | null {
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
