import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import type {BunRequest} from "bun";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
let gateway: GatewayMockup;

beforeEach(async (): Promise<void> => {
    gateway = new GatewayMockup();
    gateway.twitch.registerApp(clientId, secret);
    await gateway.identify(clientId, secret);
});

afterEach((): void => {
    gateway.dispose();
});

/** A request to /twitch/subscriptions with the app's Basic authentication. */
async function call(method: string, body?: unknown, query: string = "", credentials: string = `${clientId}:${secret}`): Promise<Response> {
    const request: BunRequest = new Request(`https://api.example.com/twitch/subscriptions${query}`, {
        method,
        headers: {"Authorization": `Basic ${Buffer.from(credentials).toString("base64")}`, "Content-Type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body),
    }) as BunRequest;
    const context: {remoteAddress: string} = {remoteAddress: "203.0.113.7"};

    if (method === "GET") return await gateway.subscriptionController.getSubscriptions(request, context);
    if (method === "POST") return await gateway.subscriptionController.createSubscription(request, context);
    return await gateway.subscriptionController.deleteSubscription(request, context);
}

const streamOnline: {type: string; condition: Record<string, string>} = {type: "stream.online", condition: {broadcaster_user_id: "555"}};

describe("subscribing to channels that never authorized the app", (): void => {
    test("POST creates it at Twitch with cost 1, GET lists it as requested", async (): Promise<void> => {
        const created: Response = await call("POST", streamOnline);
        expect(created.status).toBe(201);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("stream.online 555");

        const list: {totalCost: number; subscriptions: {type: string; cost: number; requested: boolean}[]} = await (await call("GET")).json() as never;
        expect(list.totalCost).toBe(1);
        expect(list.subscriptions.find((sub: {type: string}): boolean => sub.type === "stream.online")).toMatchObject({cost: 1, requested: true});
    });

    test("a second POST of the same subscription is 200 'already subscribed'", async (): Promise<void> => {
        await call("POST", streamOnline);
        const again: Response = await call("POST", streamOnline);

        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({created: false});
    });

    test("events of the channel reach the sessions", async (): Promise<void> => {
        await call("POST", streamOnline);
        await gateway.twitch.emit(clientId, "stream.online", {broadcaster_user_id: "555"}, {type: "live"});
        await gateway.waitFor((): boolean => gateway.events(clientId, "STREAM_ONLINE").length === 1);
    });

    test("DELETE removes it at Twitch; a second DELETE is 404", async (): Promise<void> => {
        await call("POST", streamOnline);

        expect((await call("DELETE", streamOnline)).status).toBe(204);
        expect(gateway.twitch.subscriptionSummary(clientId)).not.toContain("stream.online 555");
        expect((await call("DELETE", streamOnline)).status).toBe(404);
    });

    test("the stream.online of an authorized broadcaster stays at Twitch after DELETE", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "555", []);
        await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("stream.online 555"));
        await call("POST", streamOnline);

        expect((await call("DELETE", streamOnline)).status).toBe(204);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("stream.online 555");
    });

    test("a new conduit gets the requested subscriptions again", async (): Promise<void> => {
        await call("POST", streamOnline);
        gateway.twitch.deleteConduitExternally(gateway.twitch.conduitsOf(clientId)[0].id);

        await gateway.identify(clientId, secret);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("stream.online 555");
    });

    test("over the cost limit Twitch's 429 goes to the caller, the log warns before", async (): Promise<void> => {
        gateway.twitch.maxTotalCost = 5;
        for (let channel: number = 1; channel <= 5; channel++) {
            expect((await call("POST", {type: "stream.online", condition: {broadcaster_user_id: String(channel)}})).status).toBe(201);
        }

        const posts: number = gateway.twitch.count("POST /eventsub/subscriptions");
        const refused: Response = await call("POST", {type: "stream.online", condition: {broadcaster_user_id: "6"}});
        expect(refused.status).toBe(429);
        // The cost limit isn't the rate limit – waiting wouldn't help, so it isn't sent again.
        expect(gateway.twitch.count("POST /eventsub/subscriptions") - posts).toBe(1);
        expect(gateway.logger.messages("warn")).toContain("Subscription limit almost reached (≥ 80 %)");
        expect(gateway.logger.messages("error")).toContain("Subscription limit reached, new subscriptions fail");
    });
});

describe("authentication and validation", (): void => {
    test("a wrong secret is 401 and counts as a failed attempt", async (): Promise<void> => {
        expect((await call("GET", undefined, "", `${clientId}:wrong`)).status).toBe(401);
        expect(gateway.logger.messages("warn").some((message: string): boolean => message.includes("invalid client id or secret"))).toBe(true);
    });

    test("a type that needs authorization is 400 – nothing reaches Twitch", async (): Promise<void> => {
        const before: number = gateway.twitch.count("POST /eventsub/subscriptions");
        expect((await call("POST", {type: "channel.cheer", condition: {broadcaster_user_id: "555"}})).status).toBe(400);
        expect(gateway.twitch.count("POST /eventsub/subscriptions")).toBe(before);
    });

    test("GET with two filters is 400", async (): Promise<void> => {
        expect((await call("GET", undefined, "?type=stream.online&user_id=1")).status).toBe(400);
    });
});
