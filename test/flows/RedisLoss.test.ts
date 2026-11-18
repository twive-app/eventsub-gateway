import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import type {App} from "@twitch/app/AppStore.ts";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
const bot: string = "999";
let before: GatewayMockup;
let gateway: GatewayMockup;
let oldConduitId: string;

beforeEach(async (): Promise<void> => {
    before = new GatewayMockup();
    before.twitch.registerApp(clientId, secret);
    await before.twitch.authorize(clientId, bot, ["user:read:chat", "user:bot"]);
    await before.identify(clientId, secret, bot);
    await before.twitch.authorize(clientId, "111", ["bits:read", "channel:bot"]);
    await before.waitFor((): boolean => before.twitch.subscriptionSummary(clientId).includes("channel.chat.message 111,999"));

    // A channel that never authorized the app, subscribed through POST /twitch/subscriptions.
    const app: App | null = await before.appStore.find(clientId);
    const token: string | null = await before.appAuthenticator.getAppAccessToken(clientId);
    if (!app || !token) throw new Error("setup failed");
    await before.publicSubscriptionManager.createPublicSubscription(app, token, {type: "stream.online", version: "1", condition: {broadcaster_user_id: "555"}});
    oldConduitId = before.twitch.conduitsOf(clientId)[0].id;
    before.dispose();

    // Restart with an empty Redis – Twitch still has the conduit with every subscription.
    gateway = new GatewayMockup({}, before.twitch);
});

afterEach((): void => {
    gateway.dispose();
});

describe("Redis lost everything", (): void => {
    test("the next IDENTIFY takes over the users and public subscriptions of the old conduit", async (): Promise<void> => {
        await gateway.identify(clientId, secret, bot);

        const conduits: {id: string}[] = gateway.twitch.conduitsOf(clientId);
        expect(conduits).toHaveLength(1);
        expect(conduits[0].id).not.toBe(oldConduitId);
        expect(gateway.twitch.subscriptionSummary(clientId)).toEqual(expect.arrayContaining([
            "channel.cheer 111", "channel.chat.message 111,999", "stream.online 111", "stream.online 555",
        ]));
        expect(await gateway.appStore.getAuthorizedUsers(clientId)).toEqual(["111"]);
        expect((await gateway.appStore.getPublicSubscriptions(clientId)).map((sub: {condition: Record<string, string>}): string => sub.condition.broadcaster_user_id)).toEqual(["555"]);
    });

    test("a setup that fails keeps the old conduit – the next IDENTIFY still takes its users over", async (): Promise<void> => {
        gateway.twitch.failNext("POST /eventsub/subscriptions", 503);
        expect(await gateway.identify(clientId, secret, bot)).toBeNull();
        expect(gateway.twitch.conduitsOf(clientId).map((conduit: {id: string}): string => conduit.id)).toContain(oldConduitId);

        await gateway.identify(clientId, secret, bot);
        expect(gateway.twitch.conduitsOf(clientId)).toHaveLength(1);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("channel.cheer 111");
        expect(await gateway.appStore.getAuthorizedUsers(clientId)).toEqual(["111"]);
    });
});
