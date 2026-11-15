import type {BunRequest} from "bun";
import {EventSubTransportMethod, type EventSubSubscription} from "twitch-dev-types";
import {Autowired, Bean, Route} from "@core/bean/BeanDecorators.ts";
import type {RouteContext} from "@core/bean/BeanManager.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import type {TwitchClient, TwitchSubscriptionFilter, TwitchSubscriptionList} from "@twitch/TwitchClient.ts";
import type {AppCredentialsResult, AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";

// Twitch allows only one of these filters per request.
const filterParams: (keyof TwitchSubscriptionFilter)[] = ["user_id", "type", "status"];

/** One subscription as the endpoint returns it. */
interface SubscriptionView {
    id: string;
    type: string;
    version: string;
    status: string;
    condition: EventSubSubscription["condition"];
    cost: number;
    createdAt: string;
}

/** Body of GET /twitch/subscriptions. */
interface SubscriptionsResponse {
    conduitId: string;
    // Counts of the whole application at Twitch, not only of the listed subscriptions.
    total: number;
    totalCost: number;
    maxTotalCost: number;
    subscriptions: SubscriptionView[];
}

/** Client id + secret from an `Authorization: Basic` header. */
interface BasicCredentials {
    clientId: string;
    clientSecret: string;
}

/** GET /twitch/subscriptions: the subscriptions on the conduit of an app – authenticated with client id + secret. */
@Bean()
export class EventSubSubscriptionController {
    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private eventSubLimitService!: EventSubLimitService;

    @Autowired()
    private connectionLimitManager!: ConnectionLimitManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    /** Lists the subscriptions, optionally filtered by user_id, type or status (one of them). */
    @Route("GET", "/twitch/subscriptions")
    public async getSubscriptions(request: BunRequest, context: RouteContext): Promise<Response> {
        // Shares the failed-login block with IDENTIFY/RESUME, so the endpoint can't be used to guess secrets.
        if (this.connectionLimitManager.getAuthRejection(context.remoteAddress)) {
            return EventSubSubscriptionController.error(429, "Too Many Requests", "Too many failed authentication attempts, try again later");
        }

        const credentials: BasicCredentials | null = EventSubSubscriptionController.parseBasicAuth(request.headers.get("Authorization"));
        if (!credentials) return EventSubSubscriptionController.unauthorized("Authorization: Basic <client id>:<client secret> required");

        const query: URLSearchParams = new URL(request.url).searchParams;
        const filter: TwitchSubscriptionFilter = {};
        for (const param of filterParams) {
            const value: string | null = query.get(param);
            if (value) (filter as Record<string, string>)[param] = value;
        }
        if (Object.keys(filter).length > 1) {
            return EventSubSubscriptionController.error(400, "Bad Request", "Use only one of the filters user_id, type and status");
        }

        const result: AppCredentialsResult = await this.appAuthenticator.getCredentials(credentials.clientId, credentials.clientSecret);
        if (result.status === "unavailable") return EventSubSubscriptionController.error(503, "Service Unavailable", "Twitch could not be reached, try again later");
        if (result.status === "invalid") {
            this.connectionLimitManager.recordAuthFailure(context.remoteAddress);
            this.logger.warning("AUTH", `Subscription request with invalid credentials (client id ${credentials.clientId})`);
            return EventSubSubscriptionController.unauthorized("Invalid client id or client secret");
        }

        const app: App | null = await this.appStore.find(credentials.clientId);
        const conduitId: string | null = app?.conduitId ?? null;
        if (!app || !conduitId) return EventSubSubscriptionController.error(404, "Not Found", "This application has no conduit yet – IDENTIFY first");

        let list: TwitchSubscriptionList;
        try {
            list = await this.twitchClient.listSubscriptions({accessToken: result.credentials.accessToken, clientId: app.clientId}, filter);
        } catch (error) {
            // An invalid filter value (e.g. an unknown status) – Twitch's message tells the caller what's wrong.
            if (HttpError.statusOf(error) === 400) return EventSubSubscriptionController.error(400, "Bad Request", EventSubSubscriptionController.twitchMessage(error));

            this.errorReporter.handleThrottled("EVENTSUB", `Could not list the subscriptions of application ${app.clientId}`, error);
            return EventSubSubscriptionController.error(502, "Bad Gateway", "Twitch could not list the subscriptions, try again later");
        }

        this.eventSubLimitService.record(app.clientId, list.usage);

        const body: SubscriptionsResponse = {
            conduitId,
            total: list.usage.total,
            totalCost: list.usage.total_cost,
            maxTotalCost: list.usage.max_total_cost,
            subscriptions: list.subscriptions
                .filter((sub: EventSubSubscription): boolean => EventSubSubscriptionController.isOnConduit(sub, conduitId))
                .map((sub: EventSubSubscription): SubscriptionView => ({
                    id: sub.id,
                    type: sub.type,
                    version: sub.version,
                    status: sub.status,
                    condition: sub.condition,
                    cost: sub.cost,
                    createdAt: sub.created_at,
                })),
        };
        return Response.json(body);
    }

    /** Client id and secret of a Basic header, or null if it's missing or malformed. */
    private static parseBasicAuth(header: string | null): BasicCredentials | null {
        const match: RegExpMatchArray | null = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i) ?? null;
        if (!match) return null;

        const decoded: string = Buffer.from(match[1], "base64").toString("utf8");
        const separator: number = decoded.indexOf(":");
        if (separator <= 0 || separator === decoded.length - 1) return null;

        return {clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1)};
    }

    /** Whether a subscription is on the gateway's conduit (and not on a transport of the developer). */
    private static isOnConduit(sub: EventSubSubscription, conduitId: string): boolean {
        const transport: {method: string; conduit_id?: string} = sub.transport as {method: string; conduit_id?: string};
        return transport.method === EventSubTransportMethod.Conduit && transport.conduit_id === conduitId;
    }

    /** Twitch's own error message, or a generic one. */
    private static twitchMessage(error: unknown): string {
        const body: unknown = error instanceof HttpError ? error.body : null;
        const message: unknown = typeof body === "object" && body !== null ? (body as Record<string, unknown>).message : null;
        return typeof message === "string" && message.length > 0 ? message : "Twitch rejected the request";
    }

    /** 401 with the Basic challenge. */
    private static unauthorized(message: string): Response {
        return Response.json({error: "Unauthorized", statusCode: 401, message}, {
            status: 401,
            headers: {"WWW-Authenticate": "Basic realm=\"eventsub-gateway\", charset=\"UTF-8\""},
        });
    }

    /** JSON error in the format of the other routes. */
    private static error(status: number, error: string, message: string): Response {
        return Response.json({error, statusCode: status, message}, {status});
    }
}
