import type {ZodType} from "zod";

/**
 * The part of RedisClient the Twitch stores use (AppStore, EventSubWebhookStore), in memory. Lua scripts aren't
 * emulated – code that needs one (e.g. AppStore.removeInactive) is tested against a real Redis.
 */
export class RedisClientMockup {
    private readonly values: Map<string, string> = new Map<string, string>();
    private readonly sets: Map<string, Set<string>> = new Map<string, Set<string>>();
    private readonly hashes: Map<string, Map<string, string>> = new Map<string, Map<string, string>>();

    public async get<T>(key: string, schema?: ZodType<T>): Promise<T | null> {
        const raw: string | undefined = this.values.get(key);
        if (raw === undefined) return null;
        return schema ? this.parse(raw, schema) : JSON.parse(raw) as T;
    }

    public async set<T>(key: string, value: T): Promise<void> {
        this.values.set(key, JSON.stringify(value));
    }

    public async setIfNotExists<T>(key: string, value: T): Promise<boolean> {
        if (this.values.has(key)) return false;
        this.values.set(key, JSON.stringify(value));
        return true;
    }

    public async createIfNotExists<T>(key: string, value: T, indexKey: string, member: string): Promise<boolean> {
        if (!await this.setIfNotExists(key, value)) return false;
        await this.addToSet(indexKey, member);
        return true;
    }

    public async updateJson<T>(key: string, schema: ZodType<T>, mutate: (current: T) => T): Promise<T | null> {
        const current: T | null = await this.get(key, schema);
        if (current === null) return null;

        const next: T = mutate(current);
        this.values.set(key, JSON.stringify(next));
        return next;
    }

    public async getSetMembers(key: string): Promise<string[]> {
        return [...this.sets.get(key) ?? []];
    }

    public async addToSet(key: string, ...members: string[]): Promise<void> {
        const set: Set<string> = this.sets.get(key) ?? new Set<string>();
        for (const member of members) set.add(member);
        this.sets.set(key, set);
    }

    public async removeFromSet(key: string, ...members: string[]): Promise<void> {
        for (const member of members) this.sets.get(key)?.delete(member);
    }

    public async setHashField<T>(key: string, field: string, value: T): Promise<void> {
        const hash: Map<string, string> = this.hashes.get(key) ?? new Map<string, string>();
        hash.set(field, JSON.stringify(value));
        this.hashes.set(key, hash);
    }

    public async deleteHashField(key: string, field: string): Promise<boolean> {
        return this.hashes.get(key)?.delete(field) ?? false;
    }

    public async getHashValues<T>(key: string, schema: ZodType<T>): Promise<T[]> {
        return [...this.hashes.get(key)?.values() ?? []]
            .map((raw: string): T | null => this.parse(raw, schema))
            .filter((value: T | null): value is T => value !== null);
    }

    public async evalScript(): Promise<unknown> {
        throw new Error("RedisClientMockup runs no Lua – test this against a real Redis");
    }

    public parse<T>(value: unknown, schema: ZodType<T>): T | null {
        if (typeof value !== "string") return null;
        try {
            const parsed: {success: boolean; data?: T} = schema.safeParse(JSON.parse(value));
            return parsed.success ? parsed.data as T : null;
        } catch {
            return null;
        }
    }
}
