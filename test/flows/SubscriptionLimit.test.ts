import {afterEach, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import type {App} from "@twitch/app/AppStore.ts";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
let gateway: GatewayMockup;

beforeEach(async (): Promise<void> => {
    setSystemTime(new Date("2026-11-01T12:00:00Z"));
    gateway = new GatewayMockup();
    gateway.twitch.registerApp(clientId, secret);
    const app: App | null = await gateway.identify(clientId, secret);
    const accessToken: string | null = await gateway.appAuthenticator.findAppAccessToken(clientId);
    if (!app || !accessToken) throw new Error("setup failed");

    // One subscription with a cost: a public stream.online of a channel that never authorized the app.
    await gateway.publicSubscriptionManager.createPublicSubscription(app, accessToken, {type: "stream.online", version: "1", condition: {broadcaster_user_id: "12345"}});
});

afterEach((): void => {
    gateway.dispose();
    setSystemTime();
});

describe("the hourly subscription limit check", (): void => {
    test("asks Twitch with the stored token and reports an app at its limit", async (): Promise<void> => {
        gateway.twitch.maxTotalCost = 1;
        await gateway.limitService.refreshUsages();

        expect(gateway.limitService.countNearLimit()).toBe(1);
        expect(gateway.logger.messages("error")).toContain("Subscription limit reached, new subscriptions fail");
    });

    test("an app without a valid token is skipped and forgotten – without a warning", async (): Promise<void> => {
        gateway.twitch.maxTotalCost = 1;
        await gateway.limitService.refreshUsages();

        // The token (expires_in of the mockup: about 58 days) has expired.
        setSystemTime(new Date("2027-01-15T12:00:00Z"));
        await gateway.limitService.refreshUsages();

        expect(gateway.limitService.countNearLimit()).toBe(0);
        expect(gateway.logger.messages("warn")).not.toContain("No valid app access token until the next IDENTIFY");
    });
});
