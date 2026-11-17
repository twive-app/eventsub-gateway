import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {type Dispatched, GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
const bot: string = "999";
let gateway: GatewayMockup;

beforeEach(async (): Promise<void> => {
    gateway = new GatewayMockup();
    gateway.twitch.registerApp(clientId, secret);
    await gateway.twitch.authorize(clientId, bot, ["user:read:chat", "user:bot"]);
    await gateway.identify(clientId, secret, bot);
});

afterEach((): void => {
    gateway.dispose();
});

/** Waits until Twitch has this subscription of the app. */
async function waitForSubscription(entry: string): Promise<void> {
    await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes(entry));
}

describe("a user authorizes the app", (): void => {
    test("the grant subscribes to everything the scopes allow – chat as the bot", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read", "channel:bot"]);
        await waitForSubscription("channel.chat.message 111,999");

        expect(gateway.twitch.subscriptionSummary(clientId)).toEqual(expect.arrayContaining([
            "stream.online 111", "stream.offline 111", "channel.cheer 111", "channel.bits.use 111", "channel.chat.message 111,999",
        ]));
        expect(gateway.events(clientId, "USER_AUTHORIZATION_GRANT")).toHaveLength(1);
        expect(await gateway.appStore.getAuthorizedUsers(clientId)).toContain("111");
    });

    test("events of the user reach the sessions as DISPATCH", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await waitForSubscription("channel.cheer 111");

        await gateway.twitch.emit(clientId, "channel.cheer", {broadcaster_user_id: "111"}, {bits: 100});
        await gateway.waitFor((): boolean => gateway.events(clientId, "CHANNEL_CHEER").length === 1);
        expect(gateway.events(clientId, "CHANNEL_CHEER")[0].data).toEqual({bits: 100});
    });

    test("a subscription Twitch refuses is reported as SUBSCRIPTION_FAILED", async (): Promise<void> => {
        gateway.twitch.failNext("POST /eventsub/subscriptions", 403);
        await gateway.twitch.authorize(clientId, "111", []);
        await gateway.waitFor((): boolean => gateway.events(clientId, "SUBSCRIPTION_FAILED").length === 1);

        const failure: Dispatched = gateway.events(clientId, "SUBSCRIPTION_FAILED")[0];
        expect(failure.data).toMatchObject({type: "stream.online", condition: {broadcaster_user_id: "111"}, status: 403, message: "injected 403"});
    });

    test("revoking: Twitch revokes the subscriptions, the gateway forgets the user", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await waitForSubscription("channel.cheer 111");

        await gateway.twitch.revoke(clientId, "111");
        await gateway.waitFor(async (): Promise<boolean> => !(await gateway.appStore.getAuthorizedUsers(clientId)).includes("111"));

        expect(gateway.events(clientId, "SUBSCRIPTION_REVOKED").map((entry: Dispatched): unknown => (entry.data as {type: string}).type)).toContain("channel.cheer");
        // The revocations say authorization_revoked – the resync finds no scopes and creates nothing.
        await Bun.sleep(20);
        expect(gateway.twitch.subscriptionSummary(clientId)).not.toContain("channel.cheer 111");
        expect(gateway.events(clientId, "SUBSCRIPTION_FAILED")).toEqual([]);
    });
});

describe("Twitch revokes subscriptions of a user", (): void => {
    /** Every subscription of user 111. */
    const ofUser111: (sub: {condition: Record<string, string>}) => boolean = (sub: {condition: Record<string, string>}): boolean => Object.values(sub.condition).includes("111");

    beforeEach(async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await waitForSubscription("channel.cheer 111");
    });

    for (const status of ["authorization_revoked", "beta_maintenance"]) {
        test(`${status} while the user still authorizes the app (e.g. a password change): subscribed again`, async (): Promise<void> => {
            await gateway.twitch.revokeSubscriptions(clientId, status, ofUser111);
            expect(gateway.events(clientId, "SUBSCRIPTION_REVOKED").length).toBeGreaterThan(0);

            await waitForSubscription("channel.cheer 111");
            expect(await gateway.appStore.getAuthorizedUsers(clientId)).toContain("111");
        });
    }

    test("user_removed: the account is gone, the gateway forgets the user", async (): Promise<void> => {
        await gateway.twitch.revokeSubscriptions(clientId, "user_removed", ofUser111);
        await gateway.waitFor(async (): Promise<boolean> => !(await gateway.appStore.getAuthorizedUsers(clientId)).includes("111"));

        expect(gateway.twitch.subscriptionSummary(clientId)).not.toContain("channel.cheer 111");
    });

    test("version_removed: one error that the gateway needs an update, nothing created again", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "222", ["bits:read"]);
        await waitForSubscription("channel.cheer 222");

        // The channel.cheer of both users – one error, not one per subscription.
        await gateway.twitch.revokeSubscriptions(clientId, "version_removed", (sub: {type: string}): boolean => sub.type === "channel.cheer");
        await Bun.sleep(20);

        expect(gateway.logger.messages("error")).toEqual(["Twitch removed a subscription version the gateway uses – update the gateway"]);
        expect(gateway.twitch.subscriptionSummary(clientId)).not.toContain("channel.cheer 111");
    });
});

describe("the bot changes", (): void => {
    test("chat subscriptions move from the old to the new bot", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["channel:bot"]);
        await waitForSubscription("channel.chat.message 111,999");

        await gateway.twitch.authorize(clientId, "888", ["user:read:chat", "user:bot"]);
        await gateway.identify(clientId, secret, "888");
        await waitForSubscription("channel.chat.message 111,888");

        expect(gateway.twitch.subscriptionSummary(clientId).filter((entry: string): boolean => entry.startsWith("channel.chat.message 111"))).toEqual(["channel.chat.message 111,888"]);
        expect(gateway.logger.messages("success")).toContain("Chat subscriptions of the previous bot removed");
    });
});

describe("restoring many users on a new conduit", (): void => {
    test("one subscription list and one scope request per 10 users – not two requests per user", async (): Promise<void> => {
        for (let user: number = 1; user <= 25; user++) await gateway.twitch.authorize(clientId, String(user), []);
        await gateway.waitFor(async (): Promise<boolean> => (await gateway.appStore.getAuthorizedUsers(clientId)).length === 25);

        gateway.twitch.deleteConduitExternally(gateway.twitch.conduitsOf(clientId)[0].id);
        const before: number = gateway.twitch.count("GET /authorization/users");
        const listsBefore: number = gateway.twitch.count("GET /eventsub/subscriptions");
        await gateway.identify(clientId, secret, bot);

        // 25 users → 3 batches; the subscriptions are listed once. (The bot authorized before the gateway knew the app –
        // its grant went nowhere, so it isn't among them.)
        expect(gateway.twitch.count("GET /authorization/users") - before).toBe(3);
        expect(gateway.twitch.count("GET /eventsub/subscriptions") - listsBefore).toBe(1);
        expect(gateway.twitch.subscriptionSummary(clientId).filter((entry: string): boolean => entry.startsWith("stream.online"))).toHaveLength(25);
    });
});

describe("a revoke while the gateway restores the users", (): void => {
    beforeEach(async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await waitForSubscription("channel.cheer 111");
        // The next IDENTIFY sets up a new conduit and restores every user.
        gateway.twitch.deleteConduitExternally(gateway.twitch.conduitsOf(clientId)[0].id);
    });

    test("right after the restore read the scopes: the user stays revoked, no SUBSCRIPTION_FAILED", async (): Promise<void> => {
        gateway.twitch.interruptAfter("GET /authorization/users", async (): Promise<void> => {
            await gateway.twitch.revoke(clientId, "111");
            await gateway.waitFor(async (): Promise<boolean> => !(await gateway.appStore.getAuthorizedUsers(clientId)).includes("111"));
        });
        await gateway.identify(clientId, secret, bot);
        await Bun.sleep(20);

        expect(await gateway.appStore.getAuthorizedUsers(clientId)).not.toContain("111");
        expect(gateway.events(clientId, "SUBSCRIPTION_FAILED")).toEqual([]);
        expect(gateway.twitch.subscriptionSummary(clientId).filter((entry: string): boolean => entry.endsWith(" 111"))).toEqual([]);
    });
});
