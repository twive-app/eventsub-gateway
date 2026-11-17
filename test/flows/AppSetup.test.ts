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

describe("IDENTIFY sets up the app at Twitch", (): void => {
    test("first IDENTIFY: conduit, verified shard, authorization subscriptions", async (): Promise<void> => {
        const app: App | null = await gateway.identify(clientId, secret);

        const conduits: {id: string; shard: {status: string; callback: string} | null}[] = gateway.twitch.conduitsOf(clientId);
        expect(conduits).toHaveLength(1);
        expect(app?.conduitId).toBe(conduits[0].id);
        // The shard points to our webhook with the client id and passed Twitch's challenge.
        expect(conduits[0].shard?.status).toBe("enabled");
        expect(conduits[0].shard?.callback).toEndWith(`/twitch/webhook/callback?client_id=${clientId}`);

        expect(gateway.twitch.subscriptionSummary(clientId)).toEqual([`user.authorization.grant ${clientId}`, `user.authorization.revoke ${clientId}`]);
    });

    test("a second IDENTIFY changes nothing at Twitch", async (): Promise<void> => {
        await gateway.identify(clientId, secret);
        const calls: number = gateway.twitch.requests.length;

        await gateway.identify(clientId, secret);
        // Only the conduit list – no new conduit, no subscriptions, no token (cached).
        expect(gateway.twitch.requests.slice(calls).map((request: {method: string; path: string}): string => `${request.method} ${request.path}`)).toEqual(["GET /eventsub/conduits"]);
        expect(gateway.twitch.conduitsOf(clientId)).toHaveLength(1);
    });

    test("a conduit deleted at Twitch is replaced and every known user is subscribed again", async (): Promise<void> => {
        await gateway.identify(clientId, secret);
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 111"));

        gateway.twitch.deleteConduitExternally(gateway.twitch.conduitsOf(clientId)[0].id);
        const app: App | null = await gateway.identify(clientId, secret);

        expect(gateway.twitch.conduitsOf(clientId).map((conduit: {id: string}): string => conduit.id)).toEqual([app?.conduitId as string]);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("channel.cheer 111");
        expect(gateway.logger.messages("warn")).toContain("Gone at Twitch, creating a new one");
    });

    test("an unknown botUserId fails the IDENTIFY", async (): Promise<void> => {
        gateway.twitch.removeUser("404");
        await expect(gateway.identify(clientId, secret, "404")).rejects.toThrow("unknown botUserId");
    });

    test("Twitch failing while setting up: no session, the next IDENTIFY finishes the setup", async (): Promise<void> => {
        gateway.twitch.failNext("POST /eventsub/subscriptions", 503);
        expect(await gateway.identify(clientId, secret)).toBeNull();

        expect((await gateway.identify(clientId, secret))?.hasAuthorizationSubscriptions).toBe(true);
        expect(gateway.twitch.subscriptionSummary(clientId)).toHaveLength(2);
    });
});
