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

describe("the counters of GET /metrics", (): void => {
    test("the setup counts its Twitch requests and the authorization subscriptions it created", (): void => {
        expect(gateway.metrics.get("twitch_requests", {status: "ok"})).toBeGreaterThan(0);
        expect(gateway.metrics.get("subscriptions_created")).toBe(2);
    });

    test("an accepted webhook, the subscriptions of the grant and a refused one", async (): Promise<void> => {
        gateway.twitch.failNext("POST /eventsub/subscriptions", 403);
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => gateway.events(clientId, "SUBSCRIPTION_FAILED").length === 1);
        await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 111"));

        expect(gateway.metrics.get("webhook_messages", {type: "notification", result: "accepted"})).toBe(1);
        expect(gateway.metrics.get("subscriptions_failed", {status: "403"})).toBe(1);
        expect(gateway.metrics.get("twitch_requests", {status: "403"})).toBe(1);
        expect(gateway.metrics.get("subscriptions_created")).toBeGreaterThan(2);
    });

    test("a webhook with a wrong signature is counted without its type", async (): Promise<void> => {
        const response: Response = await gateway.webhookController.handleCallback(new Request(`https://api.example.com/twitch/webhook/callback?client_id=${clientId}`, {
            method: "POST",
            headers: {
                "Twitch-Eventsub-Message-Id": "1",
                "Twitch-Eventsub-Message-Timestamp": new Date().toISOString(),
                "Twitch-Eventsub-Message-Signature": "sha256=00",
                "Twitch-Eventsub-Message-Type": "made-up",
            },
            body: "{}",
        }) as BunRequest);

        expect(response.status).toBe(403);
        expect(gateway.metrics.get("webhook_messages", {type: "unknown", result: "invalid_signature"})).toBe(1);
    });
});
