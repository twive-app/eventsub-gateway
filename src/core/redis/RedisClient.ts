import {RedisClient as BunRedisClient} from "bun";
import type {Logger} from "@core/logging/Logger.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {ZodSafeParseResult, ZodType} from "zod";
import {Autowired, Bean, PostConstruct, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import {MainError} from "@core/error/ErrorReporter.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";

const connectTimeoutMs: number = 3000;
const maxReconnectDelayMs: number = 5000;
const maxUpdateAttempts: number = 5;
// Writes the new value only if the key still holds the value that was read (optimistic locking).
const compareAndSetScript: string = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")
    return 1
end
return 0
`;

// Runs a list of commands atomically in one script – replaces MULTI/EXEC on the shared connection.
const transactionScript: string = `
local results = {}
local position = 2
local keyIndex = 1
for i = 1, tonumber(ARGV[1]) do
    local command = {ARGV[position]}
    local keyCount = tonumber(ARGV[position + 1])
    local argCount = tonumber(ARGV[position + 2])
    for j = 1, keyCount do
        command[#command + 1] = KEYS[keyIndex]
        keyIndex = keyIndex + 1
    end
    for j = 1, argCount do command[#command + 1] = ARGV[position + 2 + j] end
    position = position + 3 + argCount
    results[i] = redis.call(unpack(command))
end
return results
`;

interface SetOptions {
    expiration?: {type: "EX" | "PX"; value: number};
    condition?: "NX" | "XX";
}

interface RedisCommand {
    name: string;
    keys: string[];
    args: string[];
}

/** Collects commands for transaction() or pipeline(). */
export class RedisClientTransaction {
    public readonly commands: RedisCommand[] = [];

    /** SET with optional expiration (EX/PX) and condition (NX/XX). */
    public set(key: string, value: string, options?: SetOptions): this {
        const args: string[] = [value];
        if (options?.expiration) args.push(options.expiration.type, String(Math.ceil(options.expiration.value)));
        if (options?.condition) args.push(options.condition);
        return this.add("SET", [key], args);
    }

    /** GET – returns the raw string. */
    public get(key: string): this {
        return this.add("GET", [key]);
    }

    /** DEL of one or more keys. */
    public del(keys: string | string[]): this {
        return this.add("DEL", this.list(keys));
    }

    /** EXISTS – 1 or 0. */
    public exists(key: string): this {
        return this.add("EXISTS", [key]);
    }

    /** INCR – the new value. */
    public incr(key: string): this {
        return this.add("INCR", [key]);
    }

    /** PEXPIRE in milliseconds, optionally only under a condition (NX, XX, GT, LT). */
    public pExpire(key: string, milliseconds: number, mode?: "NX" | "XX" | "GT" | "LT"): this {
        const args: string[] = [String(Math.ceil(milliseconds))];
        if (mode) args.push(mode);
        return this.add("PEXPIRE", [key], args);
    }

    /** SADD of one or more members. */
    public sAdd(key: string, members: string | string[]): this {
        return this.add("SADD", [key], this.list(members));
    }

    /** SREM of one or more members. */
    public sRem(key: string, members: string | string[]): this {
        return this.add("SREM", [key], this.list(members));
    }

    /** SCARD – number of members. */
    public sCard(key: string): this {
        return this.add("SCARD", [key]);
    }

    /** LRANGE of a list. */
    public lRange(key: string, start: number, stop: number): this {
        return this.add("LRANGE", [key], [String(start), String(stop)]);
    }

    /** Queues a command with its keys and arguments. */
    private add(name: string, keys: string[], args: string[] = []): this {
        this.commands.push({name, keys, args});
        return this;
    }

    /** A single value as a list. */
    private list(values: string | string[]): string[] {
        return Array.isArray(values) ? values : [values];
    }
}

/** The one connection to Redis (Bun client): JSON values with zod, atomic scripts and reconnects. */
@Bean()
export class RedisClient {
    private client: BunRedisClient | null = null;
    private reconnectTimer: Timer | null = null;
    private reconnectAttempts: number = 0;
    private shuttingDown: boolean = false;
    private readonly connectionWaiters: Set<() => void> = new Set<() => void>();

    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    /** Connects on startup – without Redis the gateway still starts and keeps reconnecting. */
    @PostConstruct()
    public initialize(): void {
        RedisKeys.setPrefix(this.configManager.get().redis.keyPrefix);

        const client: BunRedisClient = new BunRedisClient(this.connectionUrl(), {
            autoReconnect: false,
            enableOfflineQueue: false,
            connectionTimeout: connectTimeoutMs,
        });

        client.onconnect = (): void => {
            this.reconnectAttempts = 0;
            const {host, port, db, keyPrefix}: ConfigValues["redis"] = this.configManager.get().redis;
            this.logger.success("REDIS", `Connected to Redis at ${host}:${port} (db ${db}${keyPrefix ? `, key prefix ${keyPrefix}` : ""})`);
            // Wake up commands that are waiting for the connection.
            for (const resolve of this.connectionWaiters) resolve();
            this.connectionWaiters.clear();
        };

        client.onclose = (error: Error): void => {
            if (this.shuttingDown) return;
            this.logger.error("REDIS", `Connection error: ${error.message}`);
            this.scheduleReconnect();
        };

        this.client = client;
        this.connect();
    }

    /** Whether the connection is up right now. */
    public isReady(): boolean {
        return this.client?.connected ?? false;
    }

    /** Round trip of a PING in ms, or null if Redis doesn't answer within the timeout. */
    public async ping(timeoutMs: number): Promise<number | null> {
        const client: BunRedisClient | null = this.client;
        if (!client?.connected) return null;

        const startedAt: number = performance.now();
        try {
            const reply: unknown = await Promise.race([client.send("PING", []), Bun.sleep(timeoutMs).then((): null => null)]);
            return reply === "PONG" ? Math.round((performance.now() - startedAt) * 10) / 10 : null;
        } catch {
            return null;
        }
    }

    /** Reads a JSON value, validated by the schema if given; null if missing or invalid. */
    public get<T>(key: string, schema?: ZodType<T>): Promise<T | null> {
        return this.execute(async (client: BunRedisClient): Promise<T | null> => {
            const value: string | null = await client.get(key);
            if (value === null) return null;
            if (schema) return this.parse(value, schema);
            return JSON.parse(value) as T;
        });
    }

    /** Reads several JSON values in one round trip; invalid or missing ones are null. */
    public mGet<T>(keys: string[], schema: ZodType<T>): Promise<(T | null)[]> {
        return this.execute(async (client: BunRedisClient): Promise<(T | null)[]> => {
            if (keys.length === 0) return [];

            const values: unknown = await client.send("MGET", keys);
            return (values as unknown[]).map((value: unknown): T | null => this.parse(value, schema));
        });
    }

    /** Writes a JSON value, optionally with an expiration in seconds. */
    public set<T>(key: string, value: T, expireSeconds?: number): Promise<void> {
        return this.execute(async (client: BunRedisClient): Promise<void> => {
            const args: string[] = [key, JSON.stringify(value)];
            if (expireSeconds) args.push("EX", String(Math.ceil(expireSeconds)));
            await client.send("SET", args);
        });
    }

    /** Writes a JSON value only if the key doesn't exist yet; true if it was written. */
    public setIfNotExists<T>(key: string, value: T, expireSeconds: number): Promise<boolean> {
        return this.execute(async (client: BunRedisClient): Promise<boolean> => {
            const result: unknown = await client.send("SET", [key, JSON.stringify(value), "NX", "EX", String(Math.ceil(expireSeconds))]);
            return result === "OK";
        });
    }

    /** Creates a record only if it doesn't exist and adds it to an index set, atomically. */
    public async createIfNotExists<T>(key: string, value: T, indexKey: string, member: string): Promise<boolean> {
        const [result]: unknown[] = await this.transaction((multi: RedisClientTransaction): void => {
            multi.set(key, JSON.stringify(value), {condition: "NX"}).sAdd(indexKey, member);
        });
        return result === "OK";
    }

    /** Read-modify-write of a JSON value, retried if it changed meanwhile; null if the key is missing. */
    public async updateJson<T>(key: string, schema: ZodType<T>, mutate: (current: T) => T): Promise<T | null> {
        for (let attempt: number = 1; attempt <= maxUpdateAttempts; attempt++) {
            const written: T | null | undefined = await this.execute(async (client: BunRedisClient): Promise<T | null | undefined> => {
                const raw: string | null = await client.get(key);
                if (raw === null) return null;

                const parsed: ZodSafeParseResult<T> = schema.safeParse(JSON.parse(raw));
                if (!parsed.success) return null;

                const next: T = mutate(parsed.data);
                const swapped: unknown = await client.send("EVAL", [compareAndSetScript, "1", key, raw, JSON.stringify(next)]);
                // undefined = someone else changed the value in between, read it again.
                return swapped === 1 ? next : undefined;
            });

            if (written !== undefined) return written;
        }

        throw new MainError("REDIS_UPDATE_CONFLICT", `Could not update ${key} after ${maxUpdateAttempts} attempts`);
    }

    /** Runs the collected commands atomically (one Lua script, never MULTI/EXEC on the shared connection). */
    public transaction(build: (multi: RedisClientTransaction) => void): Promise<unknown[]> {
        return this.execute(async (client: BunRedisClient): Promise<unknown[]> => {
            const multi: RedisClientTransaction = new RedisClientTransaction();
            build(multi);
            if (multi.commands.length === 0) return [];

            const keys: string[] = multi.commands.flatMap((command: RedisCommand): string[] => command.keys);
            const args: string[] = [String(multi.commands.length)];
            for (const command of multi.commands) args.push(command.name, String(command.keys.length), String(command.args.length), ...command.args);
            return await client.send("EVAL", [transactionScript, String(keys.length), ...keys, ...args]) as unknown[];
        });
    }

    /** Sends the collected commands without waiting in between – not atomic. */
    public pipeline(build: (multi: RedisClientTransaction) => void): Promise<unknown[]> {
        return this.execute(async (client: BunRedisClient): Promise<unknown[]> => {
            const multi: RedisClientTransaction = new RedisClientTransaction();
            build(multi);
            return await Promise.all(multi.commands.map(({name, keys, args}: RedisCommand): Promise<unknown> => client.send(name, [...keys, ...args])));
        });
    }

    /** Runs a Lua script; every key must be passed in `keys`, never built inside the script. */
    public evalScript(script: string, keys: string[], args: string[]): Promise<unknown> {
        return this.execute(async (client: BunRedisClient): Promise<unknown> => {
            return await client.send("EVAL", [script, String(keys.length), ...keys, ...args]);
        });
    }

    /** Adds members to a set. */
    public addToSet(key: string, ...members: string[]): Promise<void> {
        return this.execute(async (client: BunRedisClient): Promise<void> => {
            if (members.length === 0) return;
            await client.send("SADD", [key, ...members]);
        });
    }

    /** Removes members from a set. */
    public removeFromSet(key: string, ...members: string[]): Promise<void> {
        return this.execute(async (client: BunRedisClient): Promise<void> => {
            if (members.length === 0) return;
            await client.send("SREM", [key, ...members]);
        });
    }

    /** All members of a set. */
    public getSetMembers(key: string): Promise<string[]> {
        return this.execute(async (client: BunRedisClient): Promise<string[]> => {
            return await client.smembers(key);
        });
    }

    /** Parses a JSON string and validates it; null if it is no string, no JSON or invalid. */
    public parse<T>(value: unknown, schema: ZodType<T>): T | null {
        if (typeof value !== "string") return null;

        let json: unknown;
        try {
            json = JSON.parse(value);
        } catch {
            return null;
        }

        const parsed: ZodSafeParseResult<T> = schema.safeParse(json);
        return parsed.success ? parsed.data : null;
    }

    /** Closes the connection last on shutdown – after everything that still writes to Redis. */
    @ShutdownHook(100)
    public close(): void {
        this.shuttingDown = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (!this.client?.connected) return;

        this.logger.info("REDIS", "Closing connection");
        this.client.close();
    }

    /** Runs a command, waiting up to 3 s for a lost connection – then it fails fast instead of queueing. */
    private async execute<T>(command: (client: BunRedisClient) => Promise<T>): Promise<T> {
        if (!this.client) throw new MainError("REDIS_NOT_INITIALIZED", "Redis has not been initialized yet");

        if (!this.client.connected) {
            await new Promise<void>((resolve: () => void): void => {
                const timer: Timer = setTimeout((): void => {
                    this.connectionWaiters.delete(done);
                    resolve();
                }, connectTimeoutMs);
                const done: () => void = (): void => {
                    clearTimeout(timer);
                    resolve();
                };
                this.connectionWaiters.add(done);
            });

            if (!this.client.connected) throw new MainError("REDIS_NOT_READY", "Redis is not connected");
        }

        return await command(this.client);
    }

    /** Opens the connection; a failure schedules a reconnect. */
    private connect(): void {
        this.client?.connect().catch((error: unknown): void => {
            if (this.shuttingDown || this.client?.connected) return;
            this.logger.error("REDIS", `Connection error: ${error instanceof Error ? error.message : String(error)}`);
            this.scheduleReconnect();
        });
    }

    /** Reconnects with a growing delay (1 s, 2 s … at most 5 s). */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        this.reconnectAttempts++;
        const delay: number = Math.min(this.reconnectAttempts * 1000, maxReconnectDelayMs);
        this.logger.warning("REDIS", `Connection was lost. Reconnecting in ${delay}ms (${this.reconnectAttempts}. try).`);

        this.reconnectTimer = setTimeout((): void => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /** redis:// URL from the configuration, with URL-encoded credentials. */
    private connectionUrl(): string {
        const {host, port, username, password, db}: ConfigValues["redis"] = this.configManager.get().redis;
        const auth: string = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
        return `redis://${auth}${host}:${port}/${db}`;
    }
}
