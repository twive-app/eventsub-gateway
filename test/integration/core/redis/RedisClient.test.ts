import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test";
import z from "zod";
import type {RedisClientTransaction} from "@core/redis/RedisClient.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {TestRedis} from "../../TestRedis.ts";

const counterSchema = z.object({count: z.number(), touchedBy: z.array(z.string())});
type Counter = z.infer<typeof counterSchema>;

describe.skipIf(!TestRedis.available)("RedisClient against Redis", (): void => {
    let redis: TestRedis;
    let key: string;

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        key = RedisKeys.twitch.app("counter");
    });

    afterEach(async (): Promise<void> => {
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("every key lands under REDIS_KEY_PREFIX", async (): Promise<void> => {
        await redis.client.set(key, {count: 0, touchedBy: []});
        expect(key.startsWith(`${redis.prefix}:twitch:`)).toBe(true);
        expect(await redis.exists(key)).toBe(true);
    });

    test("updateJson: 25 parallel updates of one value – none gets lost", async (): Promise<void> => {
        await redis.client.set<Counter>(key, {count: 0, touchedBy: []});

        // Five at a time, each retried on a conflict – more at once would run out of the five attempts.
        for (let round: number = 0; round < 5; round++) {
            await Promise.all(Array.from({length: 5}, (_: unknown, i: number): Promise<Counter | null> => (
                redis.client.updateJson(key, counterSchema, (current: Counter): Counter => ({
                    count: current.count + 1,
                    touchedBy: [...current.touchedBy, `${round}-${i}`],
                }))
            )));
        }

        const counter: Counter | null = await redis.json<Counter>(key);
        expect(counter?.count).toBe(25);
        expect(new Set(counter?.touchedBy).size).toBe(25);
    });

    test("updateJson keeps the TTL of the key", async (): Promise<void> => {
        await redis.client.set<Counter>(key, {count: 0, touchedBy: []}, 60);
        await redis.client.updateJson(key, counterSchema, (current: Counter): Counter => ({...current, count: 1}));

        expect(await redis.ttl(key)).toBeGreaterThan(55000);
    });

    test("updateJson of a missing key is null and creates nothing", async (): Promise<void> => {
        expect(await redis.client.updateJson(key, counterSchema, (current: Counter): Counter => current)).toBeNull();
        expect(await redis.exists(key)).toBe(false);
    });

    test("transaction runs every command in one step and returns the results in order", async (): Promise<void> => {
        const index: string = RedisKeys.twitch.appsIndex();
        const results: unknown[] = await redis.client.transaction((multi: RedisClientTransaction): void => {
            multi.set(key, "1", {expiration: {type: "PX", value: 60000}}).incr(key).sAdd(index, ["a", "b"]).sCard(index).get(key);
        });

        expect(results).toEqual(["OK", 2, 2, 2, "2"]);
        expect(await redis.ttl(key)).toBeGreaterThan(55000);
    });

    test("createIfNotExists: of two parallel creates exactly one wins", async (): Promise<void> => {
        const index: string = RedisKeys.twitch.appsIndex();
        const created: boolean[] = await Promise.all([
            redis.client.createIfNotExists(key, {count: 1, touchedBy: []}, index, "counter"),
            redis.client.createIfNotExists(key, {count: 2, touchedBy: []}, index, "counter"),
        ]);

        expect(created.filter(Boolean)).toHaveLength(1);
        expect(await redis.client.getSetMembers(index)).toEqual(["counter"]);
    });

    test("an invalid stored value is null instead of an exception", async (): Promise<void> => {
        await redis.raw.set(key, "{not json");
        expect(await redis.client.get(key, counterSchema)).toBeNull();

        await redis.raw.set(key, JSON.stringify({count: "one"}));
        expect(await redis.client.get(key, counterSchema)).toBeNull();
    });
});
