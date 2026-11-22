import {describe, expect, test} from "bun:test";
import type {ConfigValues} from "@core/config/ConfigManager.ts";
import {RedisClient} from "@core/redis/RedisClient.ts";
import {loadConfig} from "../../../helpers.ts";

describe("RedisClient.connectionUrl", (): void => {
    /** The Redis section of a configuration with these variables. */
    function redis(env: Record<string, string>): ConfigValues["redis"] {
        return loadConfig(env).redis;
    }

    test("redis:// with host, port and database", (): void => {
        expect(RedisClient.connectionUrl(redis({
            REDIS_HOST: "cache",
            REDIS_DB: "2",
        }))).toBe("redis://cache:6379/2");
    });

    test("rediss:// with REDIS_TLS", (): void => {
        expect(RedisClient.connectionUrl(redis({
            REDIS_HOST: "redis.example.com",
            REDIS_PORT: "6380",
            REDIS_TLS: "true",
        }))).toBe("rediss://redis.example.com:6380/0");
    });

    test("user and password are URL encoded", (): void => {
        expect(RedisClient.connectionUrl(redis({
            REDIS_USERNAME: "gate way",
            REDIS_PASSWORD: "p@ss:/word",
        }))).toBe("redis://gate%20way:p%40ss%3A%2Fword@localhost:6379/0");
    });
});
