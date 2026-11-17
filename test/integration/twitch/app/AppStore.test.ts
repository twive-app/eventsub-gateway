import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {AppStore, type App} from "@twitch/app/AppStore.ts";
import {TestRedis} from "../../TestRedis.ts";

const day: number = 24 * 60 * 60 * 1000;
const start: Date = new Date(2026, 10, 17, 12, 0, 0);

describe.skipIf(!TestRedis.available)("AppStore against Redis", (): void => {
    let redis: TestRedis;
    let store: AppStore;

    /** Every key of an app – what removeInactive has to delete. */
    function keysOf(clientId: string): string[] {
        return [
            RedisKeys.twitch.app(clientId),
            RedisKeys.twitch.appToken(clientId),
            RedisKeys.twitch.appUsers(clientId),
            RedisKeys.twitch.appPublicSubscriptions(clientId),
        ];
    }

    /** An app with a token, users and a public subscription, last used at `start`. */
    async function fullApp(clientId: string): Promise<void> {
        await store.findOrCreate(clientId);
        await store.update(clientId, {conduitId: `conduit-${clientId}`});
        await store.saveToken(clientId, {secretHash: "hash", accessToken: "token", expiresAt: Date.now() + day}, 3600);
        await store.addAuthorizedUsers(clientId, "111", "222");
        await store.addPublicSubscription(clientId, "stream.online:1:broadcaster_user_id=333", {
            type: "stream.online",
            version: "1",
            condition: {broadcaster_user_id: "333"},
            createdAt: Date.now(),
        });
    }

    /** Which of the app's keys still exist. */
    async function existing(clientId: string): Promise<boolean[]> {
        return await Promise.all(keysOf(clientId).map((key: string): Promise<boolean> => redis.exists(key)));
    }

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        setSystemTime(start);
        store = new AppStore();
    });

    afterEach(async (): Promise<void> => {
        setSystemTime();
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("five IDENTIFYs of a new app at once create it exactly once", async (): Promise<void> => {
        const apps: App[] = await Promise.all(Array.from({length: 5}, (): Promise<App> => new AppStore().findOrCreate("abc")));

        expect(new Set(apps.map((app: App): number => app.createdAt)).size).toBe(1);
        expect(await store.getClientIds()).toEqual(["abc"]);
    });

    test("parallel changes of different fields all survive", async (): Promise<void> => {
        await store.findOrCreate("abc");
        await Promise.all([
            store.update("abc", {botUserId: "999"}),
            store.update("abc", {conduitId: "conduit-1"}),
            store.update("abc", {hasAuthorizationSubscriptions: true}),
        ]);

        expect(await redis.json(RedisKeys.twitch.app("abc"))).toMatchObject({botUserId: "999", conduitId: "conduit-1", hasAuthorizationSubscriptions: true});
    });

    test("removeInactive deletes app, token, users, public subscriptions and index entry – nothing of other apps", async (): Promise<void> => {
        await fullApp("old");
        await fullApp("other");
        setSystemTime(new Date(start.getTime() + 200 * day));

        const removed: App | null = await store.removeInactive("old", Date.now() - 180 * day);

        expect(removed?.clientId).toBe("old");
        expect(await existing("old")).toEqual([false, false, false, false]);
        expect(await store.getClientIds()).toEqual(["other"]);
        expect(await existing("other")).toEqual([true, true, true, true]);
        // Its webhooks are refused from now on without asking Redis.
        expect(await store.getConduitId("old")).toBeNull();
    });

    test("removeInactive leaves an app alone that was used after the cutoff", async (): Promise<void> => {
        await fullApp("abc");
        setSystemTime(new Date(start.getTime() + 100 * day));
        await store.markActive("abc");

        expect(await store.removeInactive("abc", start.getTime() + day)).toBeNull();
        expect(await existing("abc")).toEqual([true, true, true, true]);
    });

    test("a record from before lastActiveAt counts from its last update", async (): Promise<void> => {
        await redis.client.set(RedisKeys.twitch.app("abc"), {
            clientId: "abc", botUserId: null, conduitId: null, hasAuthorizationSubscriptions: false, createdAt: 0, updatedAt: start.getTime(),
        });
        await redis.client.addToSet(RedisKeys.twitch.appsIndex(), "abc");

        expect(await store.removeInactive("abc", start.getTime() - day)).toBeNull();
        expect(await store.removeInactive("abc", start.getTime() + day)).not.toBeNull();
    });

    test("deactivate forgets the conduit of an inactive app – and keeps lastActiveAt for the retention period", async (): Promise<void> => {
        await fullApp("abc");
        setSystemTime(new Date(start.getTime() + 31 * day));

        expect(await store.deactivate("abc", start.getTime() + day)).toBe("conduit-abc");
        expect(await redis.json(RedisKeys.twitch.app("abc"))).toMatchObject({conduitId: null, hasAuthorizationSubscriptions: false, lastActiveAt: start.getTime()});
        // Users and public subscriptions stay – the next IDENTIFY restores them.
        expect(await store.getAuthorizedUsers("abc")).toHaveLength(2);
    });

    test("deactivate does nothing for an app used after the cutoff", async (): Promise<void> => {
        await fullApp("abc");
        expect(await store.deactivate("abc", start.getTime() - day)).toBeNull();
        expect(await store.getConduitId("abc", true)).toBe("conduit-abc");
    });
});
