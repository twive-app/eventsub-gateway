import crypto from "node:crypto";

/** A subscription as the mockup stores it – the shape Twitch returns. */
export interface StoredSubscription {
    id: string;
    status: string;
    type: string;
    version: string;
    condition: Record<string, string>;
    created_at: string;
    transport: {method: string; conduit_id: string};
    cost: number;
}

/** A conduit with its one shard. */
interface StoredConduit {
    id: string;
    clientId: string;
    shard: {status: string; callback: string; secret: string} | null;
}

/** One call the gateway made, for assertions like "one list request for all users". */
export interface RecordedRequest {
    method: string;
    path: string;
    query: URLSearchParams;
}

/** What the next matching call answers instead of the normal behavior. */
type InjectedFailure = number | "network";

/** Hands a webhook to the gateway – usually EventSubWebhookController.handleCallback. */
export type WebhookReceiver = (request: Request) => Promise<Response>;

// Types every app may subscribe to for any channel – they cost 1 unless the user authorized the app.
const publicTypes: Set<string> = new Set<string>([
    "stream.online", "stream.offline", "channel.update", "channel.raid", "user.update",
    "channel.shared_chat.begin", "channel.shared_chat.update", "channel.shared_chat.end",
]);
const userFields: string[] = ["broadcaster_user_id", "to_broadcaster_user_id", "from_broadcaster_user_id", "moderator_user_id", "user_id"];
const pageSize: number = 100;

/**
 * Twitch in memory: OAuth token, conduits, shards, EventSub subscriptions and authorizations behave like the real API
 * as far as the gateway relies on it, and it sends signed webhooks (challenge, notifications, revocations) to the
 * gateway. Plug it in with `spyOn(globalThis, "fetch").mockImplementation(twitch.fetch)`.
 */
export class TwitchMockup {
    public readonly requests: RecordedRequest[] = [];
    public maxTotalCost: number = 10000;

    private readonly apps: Map<string, string> = new Map<string, string>();
    private readonly tokens: Map<string, string> = new Map<string, string>();
    private readonly conduits: Map<string, StoredConduit> = new Map<string, StoredConduit>();
    private readonly subscriptions: Map<string, StoredSubscription & {clientId: string}> = new Map<string, StoredSubscription & {clientId: string}>();
    // clientId → userId → scopes
    private readonly authorizations: Map<string, Map<string, string[]>> = new Map<string, Map<string, string[]>>();
    private readonly unknownUsers: Set<string> = new Set<string>();
    private readonly failures: Map<string, InjectedFailure[]> = new Map<string, InjectedFailure[]>();
    private readonly interruptions: Map<string, (() => Promise<void>)[]> = new Map<string, (() => Promise<void>)[]>();
    private receiver: WebhookReceiver | null = null;

    // ---- setup ----------------------------------------------------------------------------------------------------

    /** A Twitch application with its secret. */
    public registerApp(clientId: string, clientSecret: string): this {
        this.apps.set(clientId, clientSecret);
        return this;
    }

    /** Where webhooks go: the gateway's webhook handler. */
    public deliverTo(receiver: WebhookReceiver): this {
        this.receiver = receiver;
        return this;
    }

    /** Get Users answers without this user (e.g. a botUserId that doesn't exist). */
    public removeUser(userId: string): this {
        this.unknownUsers.add(userId);
        return this;
    }

    /** The next `times` calls of "METHOD /path" fail with this status (or a network error). */
    public failNext(route: string, failure: InjectedFailure, times: number = 1): this {
        this.failures.set(route, [...this.failures.get(route) ?? [], ...new Array<InjectedFailure>(times).fill(failure)]);
        return this;
    }

    /**
     * Runs `action` after the next call of "METHOD /path" is answered, before the gateway reads the answer – to let
     * something happen exactly between two steps of the gateway (e.g. a revoke while it restores the users).
     */
    public interruptAfter(route: string, action: () => Promise<void>): this {
        this.interruptions.set(route, [...this.interruptions.get(route) ?? [], action]);
        return this;
    }

    // ---- what users and Twitch do -----------------------------------------------------------------------------------

    /** A user authorizes the app – Twitch sends user.authorization.grant to the app's subscriptions. */
    public async authorize(clientId: string, userId: string, scopes: string[]): Promise<void> {
        this.usersOf(clientId).set(userId, scopes);
        await this.notify(clientId, "user.authorization.grant", {client_id: clientId}, {client_id: clientId, user_id: userId, user_login: `user${userId}`, user_name: `User${userId}`});
    }

    /** A user revokes the app – its subscriptions are revoked, then user.authorization.revoke is sent. */
    public async revoke(clientId: string, userId: string): Promise<void> {
        this.usersOf(clientId).delete(userId);
        for (const sub of this.subscriptionsOf(clientId)) {
            if (publicTypes.has(sub.type) || !this.conditionUsers(sub.condition).includes(userId)) continue;
            sub.status = "authorization_revoked";
            await this.deliver(sub, "revocation", {subscription: this.view(sub)});
            this.subscriptions.delete(sub.id);
        }
        await this.notify(clientId, "user.authorization.revoke", {client_id: clientId}, {client_id: clientId, user_id: userId, user_login: null, user_name: null});
    }

    /** An event happens – every enabled subscription with this type and condition gets it. */
    public async emit(clientId: string, type: string, condition: Record<string, string>, event: Record<string, unknown>): Promise<void> {
        await this.notify(clientId, type, condition, event);
    }

    /** Someone deletes the conduit in the Twitch dashboard – its subscriptions go with it. */
    public deleteConduitExternally(conduitId: string): void {
        this.removeConduit(conduitId);
    }

    /** Twitch disables the shard after delivery failures – nothing reaches the gateway until it is updated. */
    public disableShard(conduitId: string): void {
        const shard: StoredConduit["shard"] | undefined = this.conduits.get(conduitId)?.shard;
        if (shard) shard.status = "notification_failures_exceeded";
    }

    // ---- what tests look at -----------------------------------------------------------------------------------------

    /** The conduits of an app. */
    public conduitsOf(clientId: string): {id: string; shard: StoredConduit["shard"]}[] {
        return [...this.conduits.values()]
            .filter((conduit: StoredConduit): boolean => conduit.clientId === clientId)
            .map((conduit: StoredConduit): {id: string; shard: StoredConduit["shard"]} => ({id: conduit.id, shard: conduit.shard}));
    }

    /** The subscriptions of an app. */
    public subscriptionsOf(clientId: string): (StoredSubscription & {clientId: string})[] {
        return [...this.subscriptions.values()].filter((sub: StoredSubscription & {clientId: string}): boolean => sub.clientId === clientId);
    }

    /** "type user" of every subscription, sorted – compact for assertions. */
    public subscriptionSummary(clientId: string): string[] {
        return this.subscriptionsOf(clientId)
            .map((sub: StoredSubscription): string => `${sub.type} ${this.conditionUsers(sub.condition).join(",") || sub.condition.client_id}`)
            .sort();
    }

    /** Calls of "METHOD /path" so far. */
    public count(route: string): number {
        return this.requests.filter((request: RecordedRequest): boolean => `${request.method} ${request.path}` === route).length;
    }

    // ---- the HTTP API -----------------------------------------------------------------------------------------------

    /** Drop-in for globalThis.fetch: answers Twitch, refuses everything else. */
    public readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request: Request = new Request(input instanceof URL ? input.toString() : input as string, init);
        const url: URL = new URL(request.url);
        if (url.host !== "api.twitch.tv" && url.host !== "id.twitch.tv") throw new Error(`TwitchMockup: unexpected request to ${url.host}`);

        const path: string = url.pathname.replace(/^\/helix/, "");
        const route: string = `${request.method} ${path}`;
        this.requests.push({method: request.method, path, query: url.searchParams});

        const failure: InjectedFailure | undefined = this.failures.get(route)?.shift();
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure !== undefined) return Response.json({error: "Injected", status: failure, message: `injected ${failure}`}, {status: failure});

        const response: Response = await this.answer(request, url, route);
        await this.interruptions.get(route)?.shift()?.();
        return response;
    };

    /** Twitch's answer to one request. */
    private async answer(request: Request, url: URL, route: string): Promise<Response> {
        const body: Record<string, unknown> = request.method === "GET" || request.method === "DELETE" ? {} : await request.json() as Record<string, unknown>;
        if (route === "POST /oauth2/token") return this.token(body);

        const clientId: string | null = this.authenticate(request);
        if (!clientId) return TwitchMockup.error(401, "Invalid OAuth token");

        switch (route) {
            case "GET /users": return this.users(url.searchParams);
            case "GET /eventsub/conduits": return this.listConduits(clientId);
            case "POST /eventsub/conduits": return this.createConduit(clientId);
            case "DELETE /eventsub/conduits": return this.deleteConduit(clientId, url.searchParams.get("id"));
            case "GET /eventsub/conduits/shards": return this.listShards(clientId, url.searchParams.get("conduit_id"));
            case "PATCH /eventsub/conduits/shards": return await this.updateShard(clientId, body);
            case "POST /eventsub/subscriptions": return this.createSubscription(clientId, body);
            case "GET /eventsub/subscriptions": return this.listSubscriptions(clientId, url.searchParams);
            case "DELETE /eventsub/subscriptions": return this.deleteSubscription(clientId, url.searchParams.get("id"));
            case "GET /authorization/users": return this.listAuthorizations(clientId, url.searchParams.getAll("user_id"));
            default: return TwitchMockup.error(404, `TwitchMockup doesn't know ${route}`);
        }
    }

    /** Client credentials: a token for a known app with the right secret. */
    private token(body: Record<string, unknown>): Response {
        const clientId: string = String(body.client_id);
        if (!this.apps.has(clientId)) return TwitchMockup.error(400, "invalid client");
        if (this.apps.get(clientId) !== body.client_secret) return TwitchMockup.error(403, "invalid client secret");

        const accessToken: string = crypto.randomUUID().replaceAll("-", "");
        this.tokens.set(accessToken, clientId);
        return Response.json({access_token: accessToken, expires_in: 5000000, token_type: "bearer"});
    }

    /** The app of the Bearer token, if it matches the Client-Id header. */
    private authenticate(request: Request): string | null {
        const token: string = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
        const clientId: string | undefined = this.tokens.get(token);
        return clientId && clientId === request.headers.get("Client-Id") ? clientId : null;
    }

    private users(query: URLSearchParams): Response {
        const ids: string[] = query.getAll("id").filter((id: string): boolean => !this.unknownUsers.has(id));
        return Response.json({data: ids.map((id: string): Record<string, string> => ({id, login: `user${id}`, display_name: `User${id}`}))});
    }

    private listConduits(clientId: string): Response {
        return Response.json({data: this.conduitsOf(clientId).map((conduit: {id: string}): Record<string, unknown> => ({id: conduit.id, shard_count: 1}))});
    }

    private createConduit(clientId: string): Response {
        if (this.conduitsOf(clientId).length >= 5) return TwitchMockup.error(429, "conduit limit reached");

        const conduit: StoredConduit = {id: crypto.randomUUID(), clientId, shard: null};
        this.conduits.set(conduit.id, conduit);
        return Response.json({data: [{id: conduit.id, shard_count: 1}]});
    }

    private deleteConduit(clientId: string, id: string | null): Response {
        if (!id || this.conduits.get(id)?.clientId !== clientId) return TwitchMockup.error(404, "conduit not found");
        this.removeConduit(id);
        return new Response(null, {status: 204});
    }

    private listShards(clientId: string, conduitId: string | null): Response {
        const conduit: StoredConduit | undefined = conduitId ? this.conduits.get(conduitId) : undefined;
        if (!conduit || conduit.clientId !== clientId) return TwitchMockup.error(404, "conduit not found");

        const shards: Record<string, unknown>[] = conduit.shard ? [{id: "0", status: conduit.shard.status, transport: {method: "webhook", callback: conduit.shard.callback}}] : [];
        return Response.json({data: shards, pagination: {}});
    }

    /** Sets shard 0 and verifies the callback with a challenge, like Twitch. */
    private async updateShard(clientId: string, body: Record<string, unknown>): Promise<Response> {
        const conduit: StoredConduit | undefined = this.conduits.get(String(body.conduit_id));
        if (!conduit || conduit.clientId !== clientId) return TwitchMockup.error(404, "conduit not found");

        const shard: {transport: {callback: string; secret: string}} = (body.shards as {transport: {callback: string; secret: string}}[])[0];
        conduit.shard = {status: "webhook_callback_verification_pending", callback: shard.transport.callback, secret: shard.transport.secret};

        const challenge: string = crypto.randomUUID();
        const response: Response | null = await this.send(conduit.shard, "webhook_callback_verification", {challenge});
        conduit.shard.status = response && await response.text() === challenge ? "enabled" : "webhook_callback_verification_failed";

        return Response.json({data: [{id: "0", status: conduit.shard.status, transport: {method: "webhook", callback: conduit.shard.callback}}], errors: []});
    }

    /** 409 for a duplicate, 403 without the user's authorization, 429 over the cost limit. */
    private createSubscription(clientId: string, body: Record<string, unknown>): Response {
        const transport: {method?: string; conduit_id?: string} = body.transport as {method?: string; conduit_id?: string};
        const conduit: StoredConduit | undefined = this.conduits.get(transport?.conduit_id ?? "");
        if (transport?.method !== "conduit" || conduit?.clientId !== clientId) return TwitchMockup.error(400, "invalid transport");

        const type: string = String(body.type);
        const version: string = String(body.version);
        const condition: Record<string, string> = body.condition as Record<string, string>;
        const key: string = TwitchMockup.key(type, version, condition);

        if (this.subscriptionsOf(clientId).some((sub: StoredSubscription): boolean => sub.transport.conduit_id === conduit.id && TwitchMockup.key(sub.type, sub.version, sub.condition) === key)) {
            return TwitchMockup.error(409, "subscription already exists");
        }

        const authorized: Map<string, string[]> = this.usersOf(clientId);
        const users: string[] = this.conditionUsers(condition);
        const allAuthorized: boolean = users.every((user: string): boolean => authorized.has(user));
        if (!publicTypes.has(type) && !type.startsWith("user.authorization.") && !allAuthorized) {
            return TwitchMockup.error(403, "subscription missing proper authorization");
        }

        const cost: number = publicTypes.has(type) && !allAuthorized ? 1 : 0;
        if (this.totalCost(clientId) + cost > this.maxTotalCost) return TwitchMockup.error(429, "subscription limit exceeded");

        const sub: StoredSubscription & {clientId: string} = {
            id: crypto.randomUUID(),
            status: "enabled",
            type,
            version,
            condition,
            created_at: new Date().toISOString(),
            transport: {method: "conduit", conduit_id: conduit.id},
            cost,
            clientId,
        };
        this.subscriptions.set(sub.id, sub);
        return Response.json({data: [this.view(sub)], ...this.usage(clientId)}, {status: 202});
    }

    /** One filter at most, pages of 100 with a cursor, totals for the whole app. */
    private listSubscriptions(clientId: string, query: URLSearchParams): Response {
        const filters: string[] = ["user_id", "type", "status"].filter((name: string): boolean => query.has(name));
        if (filters.length > 1) return TwitchMockup.error(400, "only one filter allowed");

        const userId: string | null = query.get("user_id");
        const matching: StoredSubscription[] = this.subscriptionsOf(clientId).filter((sub: StoredSubscription): boolean => (
            (!userId || Object.values(sub.condition).includes(userId))
            && (!query.has("type") || sub.type === query.get("type"))
            && (!query.has("status") || sub.status === query.get("status"))
        ));

        const start: number = Number(query.get("after") ?? 0);
        const page: StoredSubscription[] = matching.slice(start, start + pageSize);
        const cursor: string | undefined = start + pageSize < matching.length ? String(start + pageSize) : undefined;
        return Response.json({data: page.map((sub: StoredSubscription): StoredSubscription => this.view(sub)), pagination: cursor ? {cursor} : {}, ...this.usage(clientId)});
    }

    private deleteSubscription(clientId: string, id: string | null): Response {
        if (!id || this.subscriptions.get(id)?.clientId !== clientId) return TwitchMockup.error(404, "subscription not found");
        this.subscriptions.delete(id);
        return new Response(null, {status: 204});
    }

    /** Up to 10 user ids; users without an authorization are left out. */
    private listAuthorizations(clientId: string, userIds: string[]): Response {
        if (userIds.length === 0 || userIds.length > 10) return TwitchMockup.error(400, "between 1 and 10 user ids");

        const authorized: Map<string, string[]> = this.usersOf(clientId);
        return Response.json({
            data: userIds.filter((id: string): boolean => authorized.has(id)).map((id: string): Record<string, unknown> => ({
                user_id: id, user_login: `user${id}`, user_name: `User${id}`, scopes: authorized.get(id),
            })),
        });
    }

    // ---- webhooks -----------------------------------------------------------------------------------------------------

    /** A notification for every enabled subscription of the app with this type and condition. */
    private async notify(clientId: string, type: string, condition: Record<string, string>, event: Record<string, unknown>): Promise<void> {
        const key: string = TwitchMockup.key(type, "", condition);
        for (const sub of this.subscriptionsOf(clientId)) {
            if (sub.status !== "enabled" || TwitchMockup.key(sub.type, "", sub.condition) !== key) continue;
            await this.deliver(sub, "notification", {subscription: this.view(sub), event});
        }
    }

    /** Sends a message of a subscription through the shard of its conduit. */
    private async deliver(sub: StoredSubscription, type: string, body: Record<string, unknown>): Promise<void> {
        const shard: StoredConduit["shard"] = this.conduits.get(sub.transport.conduit_id)?.shard ?? null;
        if (!shard || shard.status !== "enabled") return;
        await this.send(shard, type, body);
    }

    /** A signed webhook request to the shard's callback; null without a receiver. */
    private async send(shard: {callback: string; secret: string}, type: string, body: Record<string, unknown>): Promise<Response | null> {
        if (!this.receiver) return null;

        const messageId: string = crypto.randomUUID();
        const timestamp: string = new Date().toISOString();
        const raw: string = JSON.stringify(body);
        const signature: string = `sha256=${crypto.createHmac("sha256", shard.secret).update(messageId + timestamp + raw).digest("hex")}`;

        return await this.receiver(new Request(shard.callback, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Twitch-Eventsub-Message-Id": messageId,
                "Twitch-Eventsub-Message-Timestamp": timestamp,
                "Twitch-Eventsub-Message-Signature": signature,
                "Twitch-Eventsub-Message-Type": type,
            },
            body: raw,
        }));
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------

    private usersOf(clientId: string): Map<string, string[]> {
        let users: Map<string, string[]> | undefined = this.authorizations.get(clientId);
        if (!users) {
            users = new Map<string, string[]>();
            this.authorizations.set(clientId, users);
        }
        return users;
    }

    private conditionUsers(condition: Record<string, string>): string[] {
        return userFields.map((field: string): string | undefined => condition[field]).filter((id: string | undefined): id is string => Boolean(id));
    }

    private removeConduit(id: string): void {
        this.conduits.delete(id);
        for (const sub of this.subscriptions.values()) {
            if (sub.transport.conduit_id === id) this.subscriptions.delete(sub.id);
        }
    }

    private totalCost(clientId: string): number {
        return this.subscriptionsOf(clientId).reduce((sum: number, sub: StoredSubscription): number => sum + sub.cost, 0);
    }

    private usage(clientId: string): {total: number; total_cost: number; max_total_cost: number} {
        return {total: this.subscriptionsOf(clientId).length, total_cost: this.totalCost(clientId), max_total_cost: this.maxTotalCost};
    }

    /** The subscription without the mockup's own fields. */
    private view(sub: StoredSubscription): StoredSubscription {
        return {id: sub.id, status: sub.status, type: sub.type, version: sub.version, condition: sub.condition, created_at: sub.created_at, transport: sub.transport, cost: sub.cost};
    }

    private static key(type: string, version: string, condition: Record<string, string>): string {
        const fields: [string, string][] = Object.entries(condition).filter((entry: [string, string]): boolean => Boolean(entry[1])).sort();
        return `${type}:${version}:${JSON.stringify(fields)}`;
    }

    private static error(status: number, message: string): Response {
        return Response.json({error: "Error", status, message}, {status});
    }
}
