import type {EventSubSubscription, RESTPostEventSubSubscriptionRequestBody, RESTPostEventSubSubscriptionResponse} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {
    TwitchClient,
    TwitchSubscriptionFilter,
    TwitchSubscriptionList,
    TwitchSubscriptionUsage,
} from "@twitch/TwitchClient.ts";
import type {App, AppStore, PublicSubscription} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import type {EventSubScopeService, PublicSubscriptionRequest} from "@twitch/eventsub/EventSubScopeService.ts";
import type {EventSubSubscriptionManager, SubscriptionFailure} from "@twitch/eventsub/EventSubSubscriptionManager.ts";
import type {RestoredUsers} from "@twitch/eventsub/EventSubUserSubscriptionManager.ts";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";

// The filters of GET /twitch/subscriptions, the most selective first – Twitch is asked once per value of the first one.
export const subscriptionFilterParams: (keyof TwitchSubscriptionFilter)[] = [
    "user_id",
    "type",
    "status",
];

/** Filters of GET /twitch/subscriptions: one of the values of a filter matches, every given filter has to match. */
export type SubscriptionListFilter = Partial<Record<keyof TwitchSubscriptionFilter, string[]>>;

/** Result of POST /twitch/subscriptions. */
export type PublicSubscribeResult = | {
    status: "created";
    subscription: EventSubSubscription | null;
} | {
    status: "exists";
} | {
    status: "failed";
    httpStatus: number | null;
    message: string;
};

/** Result of DELETE /twitch/subscriptions – `kept`: the gateway still needs it for an authorized user. */
export type PublicUnsubscribeResult = "deleted" | "kept" | "not_found" | "failed";

/** A subscription on the app's conduit and whether the app requested it with POST (not because a user authorized it). */
export interface ListedSubscription {
    subscription: EventSubSubscription;
    requested: boolean;
}

/** Result of GET /twitch/subscriptions – `rejected`: Twitch refused the filter (its message says why). */
export type SubscriptionListResult = | {
    status: "listed";
    usage: TwitchSubscriptionUsage;
    subscriptions: ListedSubscription[];
} | {
    status: "rejected";
    message: string;
} | {
    status: "failed";
};

/**
 * What /twitch/subscriptions does: lists the subscriptions on an app's conduit, and the public ones an app requests
 * (types without authorization, any channel) – creates and deletes them, remembers them and restores them on every new conduit.
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

    /**
     * The subscriptions on the app's conduit that match the filter, each marked if the app requested it. Twitch takes
     * one value of one filter per request: the gateway asks once per value of the first filter (in parallel) and checks
     * the other filters itself.
     */
    public async listSubscriptions(
        app: App,
        accessToken: string,
        filter: SubscriptionListFilter,
    ): Promise<SubscriptionListResult> {
        let lists: TwitchSubscriptionList[];
        try {
            lists = await Promise.all(EventSubPublicSubscriptionManager.toRequests(filter)
                .map((request: TwitchSubscriptionFilter): Promise<TwitchSubscriptionList> =>
                    this.twitchClient.listSubscriptions({accessToken, clientId: app.clientId}, request),
                ));
        } catch (error) {
            // An invalid filter value (e.g. an unknown status) – Twitch's message tells the caller what's wrong.
            if (HttpError.statusOf(error) === 400) return {
                status: "rejected",
                message: HttpError.messageOf(error) ?? "Twitch rejected the request",
            };

            this.logger.warnThrottled("EVENTSUB", "Could not list the subscriptions for GET /twitch/subscriptions", {
                app: app.clientId,
            }, error);
            return {
                status: "failed",
            };
        }

        // Every response carries the counts of the whole app – the last one is the newest.
        const usage: TwitchSubscriptionUsage = lists[lists.length - 1].usage;
        this.eventSubLimitService.record(app.clientId, usage);

        // A subscription can match several values (e.g. broadcaster and bot of a chat subscription) – list it once.
        const unique: Map<string, EventSubSubscription> = new Map<string, EventSubSubscription>(lists
            .flatMap((list: TwitchSubscriptionList): EventSubSubscription[] => list.subscriptions)
            .map((sub: EventSubSubscription): [string, EventSubSubscription] => [sub.id, sub]));
        const requestedKeys: Set<string> = new Set<string>((await this.appStore.getPublicSubscriptions(app.clientId))
            .map((sub: PublicSubscription): string => EventSubSubscriptionHelper.subscriptionKey(sub)));
        const subscriptions: ListedSubscription[] = [...unique.values()]
            .filter((sub: EventSubSubscription): boolean =>
                EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId)
                && EventSubPublicSubscriptionManager.matches(sub, filter),
            )
            .map((sub: EventSubSubscription): ListedSubscription => ({
                subscription: sub,
                requested: requestedKeys.has(EventSubSubscriptionHelper.subscriptionKey(sub)),
            }));

        return {
            status: "listed",
            usage,
            subscriptions,
        };
    }

    /** Creates a public subscription on the app's conduit and remembers it, so every new conduit gets it again. */
    public async createPublicSubscription(app: App, accessToken: string, request: PublicSubscriptionRequest): Promise<PublicSubscribeResult> {
        if (!app.conduitId) return {
            status: "failed",
            httpStatus: null,
            message: "The application has no conduit",
        };

        const body: RESTPostEventSubSubscriptionRequestBody = EventSubSubscriptionHelper.conduitRequest(request, app.conduitId);
        const key: string = EventSubSubscriptionHelper.subscriptionKey(body);
        const record: PublicSubscription = {
            ...request,
            createdAt: Date.now(),
        };

        try {
            const response: RESTPostEventSubSubscriptionResponse = await this.twitchClient.createSubscription(body, {
                accessToken,
                clientId: app.clientId,
            });
            this.eventSubLimitService.record(app.clientId, response);
            await this.appStore.addPublicSubscription(app.clientId, key, record);

            this.logger.success("EVENTSUB", "Subscribed (public)", {
                app: app.clientId,
                type: request.type,
                condition: request.condition,
            });
            return {
                status: "created",
                subscription: response.data[0] ?? null,
            };
        } catch (error) {
            // Already on the conduit (e.g. stream.online of an authorized user) – remember it anyway.
            if (HttpError.statusOf(error) === 409) {
                await this.appStore.addPublicSubscription(app.clientId, key, record);
                return {
                    status: "exists",
                };
            }

            const failure: SubscriptionFailure = this.eventSubSubscriptionManager.describeFailure(body, error);
            this.logger.warn("EVENTSUB", "Subscribe (public) failed", {
                app: app.clientId,
                type: request.type,
                condition: request.condition,
            }, error);
            return {
                status: "failed",
                httpStatus: failure.status,
                message: failure.message,
            };
        }
    }

    /** Deletes a public subscription the app requested – unless the gateway needs it for an authorized user. */
    public async deletePublicSubscription(app: App, accessToken: string, request: PublicSubscriptionRequest): Promise<PublicUnsubscribeResult> {
        const key: string = EventSubSubscriptionHelper.subscriptionKey(request);
        const requested: boolean = (await this.appStore.getPublicSubscriptions(app.clientId))
            .some((sub: PublicSubscription): boolean => EventSubSubscriptionHelper.subscriptionKey(sub) === key);
        if (!requested) return "not_found";

        // Every public type has exactly one user in its condition.
        const userId: string = Object.values(request.condition)[0];
        const createdForUsers: boolean = this.eventSubScopeService.isCreatedForAuthorizedUsers(request.type)
            && EventSubSubscriptionHelper.isWantedType(app.subscriptionTypes, request.type);
        if (createdForUsers && (await this.appStore.getAuthorizedUsers(app.clientId)).includes(userId)) {
            await this.appStore.removePublicSubscription(app.clientId, key);
            return "kept";
        }

        const subs: EventSubSubscription[] | null = await this.eventSubSubscriptionManager.getSubscriptions(accessToken, app.clientId, {
            user_id: userId,
        });
        if (!subs) return "failed";

        for (const sub of subs) {
            if (!EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId) || EventSubSubscriptionHelper.subscriptionKey(sub) !== key) continue;
            if (!await this.eventSubSubscriptionManager.unsubscribe(sub, accessToken, app.clientId)) return "failed";
        }

        await this.appStore.removePublicSubscription(app.clientId, key);
        this.logger.success("EVENTSUB", "Unsubscribed (public)", {
            app: app.clientId,
            type: request.type,
            condition: request.condition,
        });
        return "deleted";
    }

    /** Twitch revoked a subscription – a public one is forgotten, the app may request it again. */
    public async forgetPublicSubscription(clientId: string, sub: Pick<EventSubSubscription, "type" | "version" | "condition">): Promise<void> {
        if (await this.appStore.removePublicSubscription(clientId, EventSubSubscriptionHelper.subscriptionKey(sub))) {
            this.logger.info("EVENTSUB", "Revoked public subscription forgotten", {
                app: clientId,
                type: sub.type,
                condition: sub.condition,
            });
        }
    }

    /**
     * After the users were restored: creates the requested subscriptions that aren't on the conduit (all of them if the
     * list is unknown – 409 is fine), and takes over those of an orphaned conduit.
     */
    public async restorePublicSubscriptions(app: App, accessToken: string, restored: RestoredUsers): Promise<void> {
        if (!app.conduitId) return;

        const existingKeys: Set<string> = new Set<string>((restored.existingSubs ?? [])
            .filter((sub: EventSubSubscription): boolean => EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId))
            .map((sub: EventSubSubscription): string => EventSubSubscriptionHelper.subscriptionKey(sub)));
        const conduitId: string = app.conduitId;
        const missing: RESTPostEventSubSubscriptionRequestBody[] = restored.publicSubs
            .map((sub: PublicSubscription): RESTPostEventSubSubscriptionRequestBody => EventSubSubscriptionHelper.conduitRequest(sub, conduitId))
            .filter((sub: RESTPostEventSubSubscriptionRequestBody): boolean => !existingKeys.has(EventSubSubscriptionHelper.subscriptionKey(sub)));

        if (missing.length > 0) {
            this.logger.info("EVENTSUB", "Restoring public subscriptions", {
                app: app.clientId,
                count: missing.length,
            });
            await this.eventSubSubscriptionManager.subscribe(missing, accessToken, app.clientId);
        }

        await this.adoptPublicSubscriptions(app, accessToken, restored);
    }

    /** Public subscriptions of an orphaned conduit: public types of users that never authorized the app – requested by it. */
    private async adoptPublicSubscriptions(app: App, accessToken: string, restored: RestoredUsers): Promise<void> {
        if (!app.conduitId) return;

        const knownKeys: Set<string> = new Set<string>(restored.publicSubs.map((sub: PublicSubscription): string => EventSubSubscriptionHelper.subscriptionKey(sub)));
        const adopted: RESTPostEventSubSubscriptionRequestBody[] = [];
        for (const sub of restored.adoptedSubs) {
            const key: string = EventSubSubscriptionHelper.subscriptionKey(sub);
            const userId: string | null = EventSubSubscriptionHelper.getConditionUserId(sub);
            if (knownKeys.has(key) || !userId || !restored.unauthorized.has(userId)) continue;
            if (!this.eventSubScopeService.checkPublicSubscription({
                type: sub.type,
                version: sub.version,
                condition: sub.condition,
            }).valid) continue;

            knownKeys.add(key);
            await this.appStore.addPublicSubscription(app.clientId, key, {
                type: sub.type,
                version: sub.version,
                condition: sub.condition as Record<string, string>,
                createdAt: Date.now(),
            });
            adopted.push(EventSubSubscriptionHelper.conduitRequest(sub, app.conduitId));
        }
        if (adopted.length === 0) return;

        this.logger.info("EVENTSUB", "Taking over public subscriptions of an orphaned conduit", {
            app: app.clientId,
            count: adopted.length,
        });
        await this.eventSubSubscriptionManager.subscribe(adopted, accessToken, app.clientId);
    }

    /** The Twitch requests for a filter: one per value of the first given filter, a single unfiltered one without. */
    private static toRequests(filter: SubscriptionListFilter): TwitchSubscriptionFilter[] {
        for (const param of subscriptionFilterParams) {
            const values: string[] | undefined = filter[param];
            if (values?.length) return values.map((value: string): TwitchSubscriptionFilter => ({
                [param]: value,
            }) as TwitchSubscriptionFilter);
        }
        return [{}];
    }

    /** Whether a subscription matches every given filter – one of its values each. */
    private static matches(sub: EventSubSubscription, filter: SubscriptionListFilter): boolean {
        if (filter.user_id?.length && !filter.user_id.some((userId: string): boolean =>
            EventSubSubscriptionHelper.hasConditionUser(sub, userId),
        )) return false;
        if (filter.type?.length && !filter.type.includes(sub.type)) return false;
        return !filter.status?.length || filter.status.includes(sub.status);
    }
}
