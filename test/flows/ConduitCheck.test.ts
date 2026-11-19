import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
let gateway: GatewayMockup;
let conduitId: string;

beforeEach(async (): Promise<void> => {
    gateway = new GatewayMockup();
    gateway.twitch.registerApp(clientId, secret);
    await gateway.identify(clientId, secret);
    await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
    await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 111"));
    conduitId = gateway.twitch.conduitsOf(clientId)[0].id;
    // A client is connected – without one the check leaves the app to the next IDENTIFY.
    gateway.appsWithSessions.add(clientId);
});

afterEach((): void => {
    gateway.dispose();
});

/** Lets user 111 cheer and tells whether the event reached the sessions. */
async function cheerArrives(): Promise<boolean> {
    const before: number = gateway.events(clientId, "CHANNEL_CHEER").length;
    await gateway.twitch.emit(clientId, "channel.cheer", {broadcaster_user_id: "111"}, {bits: 100});
    await Bun.sleep(20);
    return gateway.events(clientId, "CHANNEL_CHEER").length > before;
}

describe("the conduit check every 5 minutes", (): void => {
    test("a working conduit costs one request and changes nothing", async (): Promise<void> => {
        const requests: number = gateway.twitch.requests.length;
        await gateway.appConduitCheckService.checkConduits();

        expect(gateway.twitch.requests.length - requests).toBe(1);
        expect(gateway.twitch.count("GET /eventsub/conduits/shards")).toBeGreaterThan(0);
    });

    test("a shard Twitch disabled delivers again", async (): Promise<void> => {
        gateway.twitch.disableShard(conduitId);
        expect(await cheerArrives()).toBe(false);

        await gateway.appConduitCheckService.checkConduits();

        expect(gateway.twitch.conduitsOf(clientId)[0]).toMatchObject({id: conduitId, shard: {status: "enabled"}});
        expect(await cheerArrives()).toBe(true);
        // Success only once the next check sees that Twitch verified it.
        expect(gateway.logger.messages("info")).toContain("Shard pointed to the webhook again, waiting for Twitch to verify it");
        expect(gateway.logger.messages("success")).not.toContain("Shard verified by Twitch, delivers to the webhook again");

        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.logger.messages("success")).toContain("Shard verified by Twitch, delivers to the webhook again");
    });

    test("a webhook Twitch can't verify: an error with the likely causes, until it works again", async (): Promise<void> => {
        const error: string = "Twitch can't verify the webhook – check TWITCH_WEBHOOK_SECRET and that TWITCH_WEBHOOK_CALLBACK_URL is reachable over HTTPS";
        gateway.twitch.disableShard(conduitId);
        gateway.twitch.setUnreachable(true);

        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.twitch.conduitsOf(clientId)[0].shard?.status).toBe("webhook_callback_verification_failed");
        expect(gateway.logger.messages("error")).toEqual([]);

        // Set again, failed again – no hiccup anymore.
        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.logger.messages("error")).toEqual([error]);

        gateway.twitch.setUnreachable(false);
        await gateway.appConduitCheckService.checkConduits();
        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.logger.messages("success")).toContain("Shard verified by Twitch, delivers to the webhook again");
        expect(await cheerArrives()).toBe(true);
    });

    test("a conduit Twitch deleted is set up again with every user", async (): Promise<void> => {
        gateway.twitch.deleteConduitExternally(conduitId);
        await gateway.appConduitCheckService.checkConduits();

        const conduits: {id: string}[] = gateway.twitch.conduitsOf(clientId);
        expect(conduits).toHaveLength(1);
        expect(conduits[0].id).not.toBe(conduitId);
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("channel.cheer 111");
        expect(await cheerArrives()).toBe(true);
    });

    test("revoked authorization subscriptions are created again – new users are noticed again", async (): Promise<void> => {
        await gateway.twitch.revokeSubscriptions(clientId, "version_removed", (sub: {type: string}): boolean => sub.type.startsWith("user.authorization."));
        await gateway.waitFor(async (): Promise<boolean> => (await gateway.appStore.find(clientId))?.hasAuthorizationSubscriptions === false);

        await gateway.appConduitCheckService.checkConduits();

        expect(gateway.twitch.subscriptionSummary(clientId)).toEqual(expect.arrayContaining([`user.authorization.grant ${clientId}`, `user.authorization.revoke ${clientId}`]));
        await gateway.twitch.authorize(clientId, "222", ["bits:read"]);
        await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 222"));
    });

    test("without a connected client nothing is checked", async (): Promise<void> => {
        gateway.appsWithSessions.delete(clientId);
        gateway.twitch.deleteConduitExternally(conduitId);
        const requests: number = gateway.twitch.requests.length;

        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.twitch.requests.length).toBe(requests);
    });

    test("a conduit the inactivity cleanup removed meanwhile isn't set up again", async (): Promise<void> => {
        gateway.twitch.deleteConduitExternally(conduitId);
        // Between the check and the repair the app becomes inactive.
        gateway.twitch.interruptAfter("GET /eventsub/conduits/shards", async (): Promise<void> => {
            await gateway.appStore.deactivate(clientId, Date.now() + 1);
        });

        await gateway.appConduitCheckService.checkConduits();
        expect(gateway.twitch.conduitsOf(clientId)).toEqual([]);
    });
});
