import {
    EventSubSubscriptionStatus,
    type EventSubSubscription,
    type RESTPostEventSubSubscriptionRequestBody,
    type RESTPostEventSubSubscriptionResponse,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import {GatewayDispatchEvent} from "@gateway/GatewayProtocol.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import type {TwitchSubscriptionFilter, TwitchClient} from "@twitch/TwitchClient.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";

// Subscriptions that count as existing – revoked or failed ones are created again.
const activeStatuses: Set<EventSubSubscriptionStatus> = new Set<EventSubSubscriptionStatus>([
    EventSubSubscriptionStatus.Enabled,
    EventSubSubscriptionStatus.WebhookCallbackVerificationPending,
]);

/** Data of SUBSCRIPTION_FAILED: the subscription that couldn't be created and why. */
export interface SubscriptionFailure {
    type: string;
    version: string;
    condition: RESTPostEventSubSubscriptionRequestBody["condition"];
    // HTTP status of Twitch's answer – null if Twitch wasn't reachable.
    status: number | null;
    message: string;
}

/** What creating a list of subscriptions did: created or already there (409), and the ones Twitch refused. */
export interface SubscribeOutcome {
    subscribed: RESTPostEventSubSubscriptionRequestBody[];
    failed: RESTPostEventSubSubscriptionRequestBody[];
}

/** Creates, deletes and lists EventSub subscriptions at Twitch – what Twitch refuses reaches the sessions as SUBSCRIPTION_FAILED. */
@Bean()
export class EventSubSubscriptionManager {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    @Autowired()
    private eventSubLimitService!: EventSubLimitService;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    /** Creates subscriptions, 409 counts as success; false if any failed (each one is sent as SUBSCRIPTION_FAILED). */
    public async subscribe(subs: RESTPostEventSubSubscriptionRequestBody[], accessToken: string, clientId: string): Promise<boolean> {
        return (await this.createSubscriptions(subs, accessToken, clientId)).failed.length === 0;
    }

    /** Creates the subscriptions one by one – what Twitch refused is sent as SUBSCRIPTION_FAILED, the rest goes on. */
    public async createSubscriptions(subs: RESTPostEventSubSubscriptionRequestBody[], accessToken: string, clientId: string): Promise<SubscribeOutcome> {
        const outcome: SubscribeOutcome = {subscribed: [], failed: []};
        const created: string[] = [];

        for (const sub of subs) {
            try {
                const response: RESTPostEventSubSubscriptionResponse = await this.twitchClient.createSubscription(sub, {accessToken, clientId});
                this.eventSubLimitService.record(clientId, response);
                created.push(sub.type);
                outcome.subscribed.push(sub);
                this.logger.debug("EVENTSUB", "Subscribed", {app: clientId, type: sub.type, user: EventSubSubscriptionHelper.getConditionUserId(sub)});
            } catch (error) {
                if (HttpError.statusOf(error) === 409) {
                    outcome.subscribed.push(sub);
                    this.logger.debug("EVENTSUB", "Already subscribed", {app: clientId, type: sub.type, user: EventSubSubscriptionHelper.getConditionUserId(sub)});
                    continue;
                }

                outcome.failed.push(sub);
                this.metricsRegistry.increment("subscriptions_failed", "EventSub subscriptions Twitch refused (SUBSCRIPTION_FAILED), by HTTP status", {
                    status: String(HttpError.statusOf(error) ?? "error"),
                });
                this.logger.warn("EVENTSUB", "Subscribe failed", {app: clientId, type: sub.type, condition: sub.condition}, error);
                this.sessionDispatcher.dispatch(clientId, GatewayDispatchEvent.SubscriptionFailed, this.describeFailure(sub, error));
            }
        }

        if (created.length > 0) this.metricsRegistry.increment("subscriptions_created", "EventSub subscriptions the gateway created", {}, created.length);

        // One line per user instead of one per subscription – the types only while they fit (all of them with LOG_DEBUG).
        if (created.length > 0) {
            const user: string | null = subs[0] ? EventSubSubscriptionHelper.getConditionUserId(subs[0]) : null;
            this.logger.success("EVENTSUB", "Subscribed", {app: clientId, user, count: created.length, types: created.length <= 3 ? created : undefined});
        }
        return outcome;
    }

    /** Deletes a subscription; already gone (404) is fine. False if Twitch failed. */
    public async unsubscribe(sub: EventSubSubscription, accessToken: string, clientId: string): Promise<boolean> {
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

    /** Active subscriptions of the app matching the filter; null if Twitch fails. */
    public async getSubscriptions(accessToken: string, clientId: string, filter: TwitchSubscriptionFilter = {}): Promise<EventSubSubscription[] | null> {
        let subscriptions: EventSubSubscription[];
        try {
            subscriptions = await this.twitchClient.getSubscriptions({accessToken, clientId}, filter);
        } catch (error) {
            this.logger.error("EVENTSUB", "Could not list the subscriptions", {app: clientId, user: filter.user_id}, error);
            return null;
        }

        return subscriptions.filter((sub: EventSubSubscription): boolean => activeStatuses.has(sub.status));
    }

    /** What the app learns about a failed subscription – Twitch's own message, never our request details. */
    public describeFailure(sub: RESTPostEventSubSubscriptionRequestBody, error: unknown): SubscriptionFailure {
        const status: number | null = HttpError.statusOf(error);

        let message: string;
        const twitchMessage: string | null = HttpError.messageOf(error);
        if (twitchMessage) message = twitchMessage;
        else if (status !== null) message = `Twitch answered with status ${status}`;
        else message = "Twitch could not be reached";

        return {type: sub.type, version: sub.version, condition: sub.condition, status, message};
    }
}
