import type {BunRequest} from "bun";
import type {EventSubSubscription} from "twitch-dev-types";
import {Autowired, Bean, Route} from "@core/bean/BeanDecorators.ts";
import type {RouteContext} from "@core/bean/BeanManager.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import {HttpServer} from "@core/http/HttpServer.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {clientIdPattern} from "@gateway/GatewayProtocol.ts";
import type {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import type {TwitchClient, TwitchSubscriptionFilter, TwitchSubscriptionList} from "@twitch/TwitchClient.ts";
import type {AppCredentialsResult, AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {App, AppStore, PublicSubscription} from "@twitch/app/AppStore.ts";
import type {EventSubLimitService} from "@twitch/eventsub/EventSubLimitService.ts";
import type {EventSubScopeService, PublicSubscriptionCheck, PublicSubscriptionRequest} from "@twitch/eventsub/EventSubScopeService.ts";
import type {
    EventSubPublicSubscriptionManager,
    PublicSubscribeResult,
    PublicUnsubscribeResult,
} from "@twitch/eventsub/EventSubPublicSubscriptionManager.ts";

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
    // Created with POST /twitch/subscriptions (not because a user authorized the app).
    requested: boolean;
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

/** An authenticated app with a conduit. */
interface AuthenticatedApp {
    app: App;
    conduitId: string;
    accessToken: string;
}

/** /twitch/subscriptions: list the subscriptions on an app's conduit, add and remove public ones – with client id + secret. */
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
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private eventSubPublicSubscriptionManager!: EventSubPublicSubscriptionManager;

    @Autowired()
    private connectionLimitManager!: ConnectionLimitManager;

    @Autowired()
    private logger!: Logger;

    /** Lists the subscriptions, optionally filtered by user_id, type or status (one of them). */
    @Route("GET", "/twitch/subscriptions")
    public async getSubscriptions(request: BunRequest, context: RouteContext): Promise<Response> {
        const query: URLSearchParams = new URL(request.url).searchParams;
        const filter: TwitchSubscriptionFilter = {};
        for (const param of filterParams) {
            const value: string | null = query.get(param);
            if (value) (filter as Record<string, string>)[param] = value;
        }
        if (Object.keys(filter).length > 1) {
            return HttpServer.jsonError(400, "Bad Request", "Use only one of the filters user_id, type and status");
        }

        const auth: AuthenticatedApp | Response = await this.authenticate(request, context);
        if (auth instanceof Response) return auth;
        const {app, conduitId, accessToken}: AuthenticatedApp = auth;

        let list: TwitchSubscriptionList;
        try {
            list = await this.twitchClient.listSubscriptions({accessToken, clientId: app.clientId}, filter);
        } catch (error) {
            // An invalid filter value (e.g. an unknown status) – Twitch's message tells the caller what's wrong.
            if (HttpError.statusOf(error) === 400) return HttpServer.jsonError(400, "Bad Request", HttpError.messageOf(error) ?? "Twitch rejected the request");

            this.logger.warnThrottled("EVENTSUB", "Could not list the subscriptions for GET /twitch/subscriptions", {app: app.clientId}, error);
            return HttpServer.jsonError(502, "Bad Gateway", "Twitch could not list the subscriptions, try again later");
        }

        this.eventSubLimitService.record(app.clientId, list.usage);

        const requestedKeys: Set<string> = new Set<string>((await this.appStore.getPublicSubscriptions(app.clientId))
            .map((sub: PublicSubscription): string => this.eventSubScopeService.subscriptionKey(sub)));

        const body: SubscriptionsResponse = {
            conduitId,
            total: list.usage.total,
            totalCost: list.usage.total_cost,
            maxTotalCost: list.usage.max_total_cost,
            subscriptions: list.subscriptions
                .filter((sub: EventSubSubscription): boolean => this.eventSubScopeService.isOnConduit(sub, conduitId))
                .map((sub: EventSubSubscription): SubscriptionView => this.toView(sub, requestedKeys.has(this.eventSubScopeService.subscriptionKey(sub)))),
        };
        return Response.json(body);
    }

    /** Subscribes to an event that needs no authorization (e.g. stream.online) for any channel. */
    @Route("POST", "/twitch/subscriptions")
    public async createSubscription(request: BunRequest, context: RouteContext): Promise<Response> {
        const subscription: PublicSubscriptionRequest | Response = await this.checkBody(request);
        if (subscription instanceof Response) return subscription;

        const auth: AuthenticatedApp | Response = await this.authenticate(request, context);
        if (auth instanceof Response) return auth;

        const result: PublicSubscribeResult = await this.eventSubPublicSubscriptionManager.createPublicSubscription(auth.app, auth.accessToken, subscription);
        switch (result.status) {
            case "created":
                return Response.json({created: true, subscription: result.subscription ? this.toView(result.subscription, true) : null}, {status: 201});
            case "exists":
                return Response.json({created: false, subscription: null});
            case "failed":
                // Twitch's client errors (e.g. 429: limit reached) go to the caller as they are.
                if (result.httpStatus !== null && result.httpStatus >= 400 && result.httpStatus < 500) {
                    return HttpServer.jsonError(result.httpStatus, "Twitch rejected the subscription", result.message);
                }
                return HttpServer.jsonError(502, "Bad Gateway", result.message);
        }
    }

    /** Removes a public subscription the app created with POST (same body). */
    @Route("DELETE", "/twitch/subscriptions")
    public async deleteSubscription(request: BunRequest, context: RouteContext): Promise<Response> {
        const subscription: PublicSubscriptionRequest | Response = await this.checkBody(request);
        if (subscription instanceof Response) return subscription;

        const auth: AuthenticatedApp | Response = await this.authenticate(request, context);
        if (auth instanceof Response) return auth;

        const result: PublicUnsubscribeResult = await this.eventSubPublicSubscriptionManager.deletePublicSubscription(auth.app, auth.accessToken, subscription);
        switch (result) {
            case "deleted":
            case "kept":
                return new Response(null, {status: 204});
            case "not_found":
                return HttpServer.jsonError(404, "Not Found", "This application didn't request this subscription");
            case "failed":
                return HttpServer.jsonError(502, "Bad Gateway", "Twitch could not delete the subscription, try again later");
        }
    }

    /** The validated body of POST/DELETE, or the 400 to answer with. */
    private async checkBody(request: BunRequest): Promise<PublicSubscriptionRequest | Response> {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return HttpServer.jsonError(400, "Bad Request", "The body must be JSON: {\"type\": \"stream.online\", \"condition\": {...}}");
        }

        const check: PublicSubscriptionCheck = this.eventSubScopeService.checkPublicSubscription(body);
        return check.valid ? check.subscription : HttpServer.jsonError(400, "Bad Request", check.message);
    }

    /** Checks Basic auth (sharing the failed-login block with IDENTIFY/RESUME) and that the app has a conduit. */
    private async authenticate(request: BunRequest, context: RouteContext): Promise<AuthenticatedApp | Response> {
        // Shares the block with IDENTIFY/RESUME, so these endpoints can't be used to guess secrets.
        if (this.connectionLimitManager.getAuthRejection(context.remoteAddress)) {
            return HttpServer.jsonError(429, "Too Many Requests", "Too many failed authentication attempts, try again later");
        }

        const credentials: BasicCredentials | null = EventSubSubscriptionController.parseBasicAuth(request.headers.get("Authorization"));
        if (!credentials) return EventSubSubscriptionController.unauthorized("Authorization: Basic <client id>:<client secret> required");

        const result: AppCredentialsResult = await this.appAuthenticator.getCredentials(credentials.clientId, credentials.clientSecret);
        if (result.status === "unavailable") return HttpServer.jsonError(503, "Service Unavailable", "Twitch could not be reached, try again later");
        if (result.status === "invalid") {
            this.connectionLimitManager.recordAuthFailure(context.remoteAddress);
            this.logger.warn("AUTH", `${request.method} /twitch/subscriptions rejected: invalid client id or secret`, {app: credentials.clientId, ip: context.remoteAddress});
            return EventSubSubscriptionController.unauthorized("Invalid client id or client secret");
        }

        const app: App | null = await this.appStore.find(credentials.clientId);
        const conduitId: string | null = app?.conduitId ?? null;
        if (!app || !conduitId) return HttpServer.jsonError(404, "Not Found", "This application has no conduit yet – IDENTIFY first");

        return {app, conduitId, accessToken: result.credentials.accessToken};
    }

    /** A Twitch subscription in the shape of the endpoint. */
    private toView(sub: EventSubSubscription, requested: boolean): SubscriptionView {
        return {
            id: sub.id,
            type: sub.type,
            version: sub.version,
            status: sub.status,
            condition: sub.condition,
            cost: sub.cost,
            createdAt: sub.created_at,
            requested,
        };
    }

    /** Client id and secret of a Basic header, or null if it's missing or malformed. */
    private static parseBasicAuth(header: string | null): BasicCredentials | null {
        const match: RegExpMatchArray | null = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i) ?? null;
        if (!match) return null;

        const decoded: string = Buffer.from(match[1], "base64").toString("utf8");
        const separator: number = decoded.indexOf(":");
        if (separator <= 0 || separator === decoded.length - 1) return null;

        // The same rules as IDENTIFY: a client id of letters and digits, a secret of sensible length.
        const clientId: string = decoded.slice(0, separator);
        const clientSecret: string = decoded.slice(separator + 1);
        if (!clientIdPattern.test(clientId) || clientSecret.length > 128) return null;
        return {clientId, clientSecret};
    }

    /** 401 with the Basic challenge. */
    private static unauthorized(message: string): Response {
        return HttpServer.jsonError(401, "Unauthorized", message, {"WWW-Authenticate": "Basic realm=\"eventsub-gateway\", charset=\"UTF-8\""});
    }
}
