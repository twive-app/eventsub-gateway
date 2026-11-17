import crypto from "node:crypto";
import {RedisClient as BunRedisClient} from "bun";
import {RedisClient} from "@core/redis/RedisClient.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {loadConfig, provideBean} from "../helpers.ts";
import {ConfigManagerMockup} from "../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../mockups/LoggerMockup.ts";

// e.g. redis://localhost:6379/15 – without it the integration tests are skipped, except in CI.
const url: string | undefined = process.env.TEST_REDIS_URL;
if (!url && process.env.CI) throw new Error("TEST_REDIS_URL is required in CI – the integration tests must not be skipped there");

/**
 * A real Redis for the integration tests (TEST_REDIS_URL). Every instance writes under its own random key prefix and
 * deletes only those keys – it never flushes a database, so a Redis with other data stays untouched.
 */
export class TestRedis {
    public static readonly available: boolean = Boolean(url);

    public readonly prefix: string = `test-${crypto.randomUUID().slice(0, 8)}`;
    public readonly configManager: ConfigManagerMockup = new ConfigManagerMockup(this.load());
    public readonly logger: LoggerMockup = new LoggerMockup();
    public readonly client: RedisClient;
    // A second connection to look at the keys directly (TTLs, raw values) – not through the code under test.
    public readonly raw: BunRedisClient = new BunRedisClient(url);

    private constructor() {
        provideBean("configManager", this.configManager);
        provideBean("logger", this.logger);
        this.client = new RedisClient();
        provideBean("redisClient", this.client);
    }

    /** Connects both clients; register further beans after this. */
    public static async connect(): Promise<TestRedis> {
        const redis: TestRedis = new TestRedis();
        redis.client.initialize();
        await redis.raw.connect();
        // The first command waits until the client is connected.
        await redis.client.getSetMembers(RedisKeys.twitch.appsIndex());
        return redis;
    }

    /** Changes gateway variables for the following calls – the beans read the configuration on every call. */
    public configure(env: Record<string, string>): void {
        this.configManager.set(this.load(env));
    }

    /** Back to the default configuration and to this prefix (another test file may have changed the global one). */
    public reset(): void {
        this.configManager.set(this.load());
        RedisKeys.setPrefix(this.prefix);
    }

    /** Deletes every key under this prefix. */
    public async clear(): Promise<void> {
        let cursor: string = "0";
        do {
            const [next, keys]: [string, string[]] = await this.raw.send("SCAN", [cursor, "MATCH", `${this.prefix}:*`, "COUNT", "1000"]) as [string, string[]];
            if (keys.length > 0) await this.raw.send("DEL", keys);
            cursor = next;
        } while (cursor !== "0");
    }

    /** Clears the keys, closes both connections and takes the prefix back out of RedisKeys. */
    public async close(): Promise<void> {
        await this.clear();
        this.client.close();
        this.raw.close();
        RedisKeys.setPrefix("");
    }

    /** Remaining time to live of a key in ms (-1 without, -2 if it doesn't exist). */
    public async ttl(key: string): Promise<number> {
        return Number(await this.raw.send("PTTL", [key]));
    }

    /** Whether a key exists. */
    public async exists(key: string): Promise<boolean> {
        return Number(await this.raw.send("EXISTS", [key])) > 0;
    }

    /** A JSON value as stored. */
    public async json<T>(key: string): Promise<T | null> {
        const value: string | null = await this.raw.get(key);
        return value === null ? null : JSON.parse(value) as T;
    }

    /** The configuration with this Redis, this prefix and `env`. */
    private load(env: Record<string, string> = {}): ReturnType<typeof loadConfig> {
        const target: URL = new URL(url ?? "redis://localhost:6379");
        return loadConfig({
            REDIS_HOST: target.hostname,
            REDIS_PORT: target.port || "6379",
            REDIS_DB: target.pathname.slice(1) || "0",
            REDIS_USERNAME: decodeURIComponent(target.username) || undefined,
            REDIS_PASSWORD: decodeURIComponent(target.password) || undefined,
            REDIS_KEY_PREFIX: this.prefix,
            ...env,
        });
    }
}
