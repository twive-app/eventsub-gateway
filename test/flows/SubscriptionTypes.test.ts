import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import type {App} from "@twitch/app/AppStore.ts";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
let gateway: GatewayMockup;

beforeEach((): void => {
    gateway = new GatewayMockup();
    gateway.twitch.registerApp(clientId, secret);
});

afterEach((): void => {
    gateway.dispose();
});

/** The subscriptions of user 111 at Twitch. */
function ofUser111(): string[] {
    return gateway.twitch.subscriptionSummary(clientId).filter((entry: string): boolean => entry.endsWith(" 111"));
}

describe("subscriptionTypes of IDENTIFY", (): void => {
    test("only these types are created for an authorized user – the authorization subscriptions stay", async (): Promise<void> => {
        await gateway.identify(clientId, secret, undefined, ["channel.cheer"]);
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => gateway.events(clientId, "USER_SUBSCRIBED").length === 1);

        expect(ofUser111()).toEqual(["channel.cheer 111"]);
        expect(gateway.events(clientId, "USER_SUBSCRIBED")[0].data).toMatchObject({events: ["CHANNEL_CHEER"], failed: []});
        expect(gateway.twitch.subscriptionSummary(clientId)).toEqual(expect.arrayContaining([
            `user.authorization.grant ${clientId}`, `user.authorization.revoke ${clientId}`,
        ]));
    });

    test("a change deletes what is no longer wanted and creates what is new; null allows everything again", async (): Promise<void> => {
        await gateway.identify(clientId, secret);
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => ofUser111().includes("channel.cheer 111"));

        await gateway.identify(clientId, secret, undefined, ["stream.online"]);
        await gateway.waitFor((): boolean => ofUser111().join() === "stream.online 111");

        await gateway.identify(clientId, secret, undefined, null);
        await gateway.waitFor((): boolean => ofUser111().includes("channel.cheer 111") && ofUser111().includes("stream.offline 111"));
    });

    test("omitted keeps the stored types", async (): Promise<void> => {
        await gateway.identify(clientId, secret, undefined, ["channel.cheer"]);
        const app: App | null = await gateway.identify(clientId, secret);

        expect(app?.subscriptionTypes).toEqual(["channel.cheer"]);
    });

    test("a requested public subscription stays although its type isn't wanted for authorized users", async (): Promise<void> => {
        const app: App | null = await gateway.identify(clientId, secret);
        const accessToken: string | null = await gateway.appAuthenticator.findAppAccessToken(clientId);
        if (!app || !accessToken) throw new Error("setup failed");
        await gateway.publicSubscriptionManager.createPublicSubscription(app, accessToken, {type: "stream.online", version: "1", condition: {broadcaster_user_id: "555"}});
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => ofUser111().includes("stream.online 111"));

        await gateway.identify(clientId, secret, undefined, ["channel.cheer"]);
        await gateway.waitFor((): boolean => ofUser111().join() === "channel.cheer 111");

        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("stream.online 555");
    });
});
