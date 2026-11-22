import {
    APIConduitShardTransportMethod,
    APIEndpoint,
    OAuth2Endpoint,
    OAuth2GrantType,
    type EventSubSubscription,
    type RESTGetAuthorizationByUserResponse,
    type RESTGetConduitShardsResponse,
    type RESTGetConduitsResponse,
    type RESTGetEventSubSubscriptionsRequestParams,
    type RESTGetEventSubSubscriptionsResponse,
    type RESTGetUsersResponse,
    type RESTPatchConduitShardsResponse,
    type RESTPostClientCredentialsGrantFlowTokenResponse,
    type RESTPostConduitsResponse,
    type RESTPostEventSubSubscriptionRequestBody,
    type RESTPostEventSubSubscriptionResponse,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError, type HttpClient} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";

// Twitch's request budget per app: a 429 with Ratelimit-Remaining: 0 waits for Ratelimit-Reset, then tries again.
const maxRateLimitRetries: number = 3;
const maxRateLimitWaitMs: number = 60000;
const rateLimitJitterMs: number = 250;

interface AppAuth {
    accessToken: string;
    clientId: string;
}

export type TwitchSubscriptionFilter = Pick<RESTGetEventSubSubscriptionsRequestParams, "user_id" | "type" | "status">;

/** Subscription count and cost of an application – Twitch sends them with every list and create response. */
export type TwitchSubscriptionUsage = Pick<RESTGetEventSubSubscriptionsResponse, "total" | "total_cost" | "max_total_cost">;

/** Subscriptions of a list request with the app's usage. */
export interface TwitchSubscriptionList {
    subscriptions: EventSubSubscription[];
    usage: TwitchSubscriptionUsage;
}

/** Every call to the Twitch API (Helix and OAuth) – nothing else talks to Twitch over HTTP. */
@Bean()
export class TwitchClient {
    @Autowired()
    private httpClient!: HttpClient;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    /** App access token via the client credentials flow – fails if id or secret are wrong. */
    public async requestAppToken(clientId: string, clientSecret: string): Promise<RESTPostClientCredentialsGrantFlowTokenResponse> {
        return await this.post<RESTPostClientCredentialsGrantFlowTokenResponse>(OAuth2Endpoint.Token, {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: OAuth2GrantType.ClientCredentials,
        });
    }

    /** Users by id (used to check the bot user). */
    public async getUsersById(ids: string[], auth: AppAuth): Promise<RESTGetUsersResponse> {
        return await this.get<RESTGetUsersResponse>(APIEndpoint.GetUsers, {
            id: ids,
        }, this.headers(auth));
    }

    /** All conduits of the application. */
    public async getConduits(auth: AppAuth): Promise<RESTGetConduitsResponse> {
        return await this.get<RESTGetConduitsResponse>(APIEndpoint.GetConduits, undefined, this.headers(auth));
    }

    /** Shards of a conduit with their callback and status. */
    public async getConduitShards(conduitId: string, auth: AppAuth): Promise<RESTGetConduitShardsResponse> {
        return await this.get<RESTGetConduitShardsResponse>(APIEndpoint.GetConduitShards, {
            conduit_id: conduitId,
        }, this.headers(auth));
    }

    /** Creates a conduit with one shard. */
    public async createConduit(auth: AppAuth): Promise<RESTPostConduitsResponse> {
        return await this.post<RESTPostConduitsResponse>(APIEndpoint.CreateConduits, {
            shard_count: 1,
        }, this.headers(auth));
    }

    /** Deletes a conduit (and with it all its subscriptions). */
    public async deleteConduit(conduitId: string, auth: AppAuth): Promise<void> {
        await this.delete(APIEndpoint.DeleteConduit, {
            id: conduitId,
        }, this.headers(auth));
    }

    /** Points shard 0 to the webhook callback – Twitch then verifies the callback with a challenge. */
    public async updateConduitShard(conduitId: string, callback: string, secret: string, auth: AppAuth): Promise<RESTPatchConduitShardsResponse> {
        return await this.patch<RESTPatchConduitShardsResponse>(APIEndpoint.UpdateConduitShards, {
            conduit_id: conduitId,
            shards: [
                {
                    id: "0",
                    transport: {
                        method: APIConduitShardTransportMethod.Webhook,
                        callback,
                        secret,
                    },
                },
            ],
        }, this.headers(auth));
    }

    /** Creates an EventSub subscription – 409 if it exists already. */
    public async createSubscription(subscription: RESTPostEventSubSubscriptionRequestBody, auth: AppAuth): Promise<RESTPostEventSubSubscriptionResponse> {
        return await this.post<RESTPostEventSubSubscriptionResponse>(APIEndpoint.CreateEventSubSubscription, subscription, this.headers(auth));
    }

    /** All subscriptions matching the filter, following the pagination. */
    public async getSubscriptions(auth: AppAuth, filter: TwitchSubscriptionFilter = {}): Promise<EventSubSubscription[]> {
        return (await this.listSubscriptions(auth, filter)).subscriptions;
    }

    /** All subscriptions matching the filter plus the app's count and cost (from the last page). */
    public async listSubscriptions(auth: AppAuth, filter: TwitchSubscriptionFilter = {}): Promise<TwitchSubscriptionList> {
        const subscriptions: EventSubSubscription[] = [];
        let usage: TwitchSubscriptionUsage = {total: 0, total_cost: 0, max_total_cost: 0};
        let cursor: string | undefined = undefined;

        do {
            const response: RESTGetEventSubSubscriptionsResponse = await this.get<RESTGetEventSubSubscriptionsResponse>(
                APIEndpoint.GetEventSubSubscriptions,
                {
                    ...filter,
                    after: cursor,
                },
                this.headers(auth),
            );

            subscriptions.push(...response.data);
            usage = {
                total: response.total,
                total_cost: response.total_cost,
                max_total_cost: response.max_total_cost,
            };

            cursor = response.pagination?.cursor || undefined;
        } while (cursor);

        return {
            subscriptions,
            usage,
        };
    }

    /** Subscription count and cost of the app – only the first page, the totals are the same on every page. */
    public async getSubscriptionUsage(auth: AppAuth): Promise<TwitchSubscriptionUsage> {
        const response: RESTGetEventSubSubscriptionsResponse = await this.get<RESTGetEventSubSubscriptionsResponse>(
            APIEndpoint.GetEventSubSubscriptions,
            undefined,
            this.headers(auth),
        );

        return {
            total: response.total,
            total_cost: response.total_cost,
            max_total_cost: response.max_total_cost,
        };
    }

    /** Deletes a subscription. */
    public async deleteSubscription(subscriptionId: string, auth: AppAuth): Promise<void> {
        await this.delete(APIEndpoint.DeleteEventSubSubscription, {
            id: subscriptionId,
        }, this.headers(auth));
    }

    /** Scopes the users have granted the application – at most 10 user ids per request (Twitch's limit). */
    public async getAuthorizations(userIds: string[], auth: AppAuth): Promise<RESTGetAuthorizationByUserResponse> {
        return await this.get<RESTGetAuthorizationByUserResponse>(APIEndpoint.GetAuthorizationByUser, {
            user_id: userIds,
        }, this.headers(auth));
    }

    /** GET through the rate limit. */
    private get<T>(url: string, params: object | undefined, headers: Record<string, string>): Promise<T> {
        return this.withRateLimit((): Promise<T> => this.httpClient.get<T>(url, params, headers));
    }

    /** POST through the rate limit. */
    private post<T>(url: string, data: object, headers?: Record<string, string>): Promise<T> {
        return this.withRateLimit((): Promise<T> => this.httpClient.post<T>(url, data, headers));
    }

    /** PATCH through the rate limit. */
    private patch<T>(url: string, data: object, headers: Record<string, string>): Promise<T> {
        return this.withRateLimit((): Promise<T> => this.httpClient.patch<T>(url, data, headers));
    }

    /** DELETE through the rate limit. */
    private delete<T>(url: string, params: object, headers: Record<string, string>): Promise<T> {
        return this.withRateLimit((): Promise<T> => this.httpClient.delete<T>(url, params, headers));
    }

    /** Sends the request again while Twitch says the app's request budget is spent – at most a few times. */
    private async withRateLimit<T>(send: () => Promise<T>): Promise<T> {
        for (let retry: number = 0; ; retry++) {
            try {
                const result: T = await send();
                this.countRequest("ok");
                return result;
            } catch (error) {
                // The HTTP status, or "error" if Twitch couldn't be reached.
                this.countRequest(String(HttpError.statusOf(error) ?? "error"));

                const waitMs: number | null = TwitchClient.rateLimitWait(error);
                if (waitMs === null || retry >= maxRateLimitRetries) throw error;

                this.metricsRegistry.increment("twitch_rate_limit_waits", "Waits for Twitch's request budget (429 without requests left)");
                this.logger.warnThrottled("HTTP", "Twitch rate limit reached, waiting for the reset", {
                    waitMs: Math.round(waitMs),
                });

                await Bun.sleep(waitMs);
            }
        }
    }

    /** Counts a request to Twitch by its outcome: ok, the HTTP status of an error, or "error". */
    private countRequest(status: string): void {
        this.metricsRegistry.increment("twitch_requests", "Requests to the Twitch API (Helix and OAuth) by outcome", {
            status,
        });
    }

    /**
     * How long until Twitch's request budget refills – null if the error isn't the rate limit. The subscription limit
     * also answers 429, but with requests left: waiting wouldn't help there.
     */
    private static rateLimitWait(error: unknown): number | null {
        if (!(error instanceof HttpError) || error.status !== 429) return null;

        const headers: Record<string, string> = error.exchange?.responseHeaders ?? {};
        if (headers["ratelimit-remaining"] !== "0") return null;

        const resetAt: number = Number(headers["ratelimit-reset"]) * 1000;
        const waitMs: number = Number.isFinite(resetAt) && resetAt > 0 ? resetAt - Date.now() : 1000;
        return Math.min(Math.max(waitMs, 0), maxRateLimitWaitMs) + Math.random() * rateLimitJitterMs;
    }

    /** Helix headers for an app access token. */
    private headers(auth: AppAuth): Record<string, string> {
        return {
            "Authorization": `Bearer ${auth.accessToken}`,
            "Client-Id": auth.clientId,
        };
    }
}
