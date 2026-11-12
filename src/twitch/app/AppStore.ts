import z from "zod";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {MainError} from "@core/error/ErrorReporter.ts";
import type {RedisClient} from "@core/redis/RedisClient.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";

// The stored application – defaults fill fields that older records don't have yet.
const appSchema = z.object({
    clientId: z.string(),
    botUserId: z.string().nullable().default(null),
    conduitId: z.string().nullable(),
    hasAuthorizationSubscriptions: z.boolean().default(false),
    lastActiveAt: z.number().nullable().default(null),
    createdAt: z.number(),
    updatedAt: z.number(),
});

/** An application (Twitch client id) the gateway manages: bot user, conduit and setup state. */
export interface App {
    clientId: string;
    botUserId: string | null;
    conduitId: string | null;
    hasAuthorizationSubscriptions: boolean;
    // Last IDENTIFY or hourly check with a session – null for records from before this field.
    lastActiveAt: number | null;
    createdAt: number;
    updatedAt: number;
}

/** Fields of an application that may change. */
type AppPatch = Partial<Pick<App, "botUserId" | "conduitId" | "hasAuthorizationSubscriptions" | "lastActiveAt">>;

// Deletes every key of an app inactive since before ARGV[1] – unless an IDENTIFY changed lastActiveAt meanwhile.
const removeInactiveScript: string = `
local raw = redis.call("GET", KEYS[1])
if not raw then return false end
local app = cjson.decode(raw)
local lastActiveAt = app.lastActiveAt
if lastActiveAt == nil or lastActiveAt == cjson.null then lastActiveAt = app.updatedAt end
if tonumber(lastActiveAt) > tonumber(ARGV[1]) then return false end
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
redis.call("SREM", KEYS[4], ARGV[2])
return raw
`;

const appTokenSchema = z.object({
    secretHash: z.string(),
    accessToken: z.string(),
    expiresAt: z.number(),
});

/** Cached app access token with the hash of the secret it was requested with. */
export type AppToken = z.infer<typeof appTokenSchema>;

/** Owns the Twitch keys in Redis: applications, app access tokens and authorized users. */
@Bean()
export class AppStore {
    @Autowired()
    private redisClient!: RedisClient;

    // Conduit id per app in memory – checked for every incoming event, so it must not cost a Redis call.
    private readonly conduitIds: Map<string, string | null> = new Map<string, string | null>();

    /** The application with this client id, or null. */
    public async find(clientId: string): Promise<App | null> {
        return this.remember(clientId, await this.redisClient.get(RedisKeys.twitch.app(clientId), appSchema));
    }

    /** Conduit id of an application – from memory unless `fresh`. */
    public async getConduitId(clientId: string, fresh: boolean = false): Promise<string | null> {
        const cached: string | null | undefined = this.conduitIds.get(clientId);
        if (cached !== undefined && !fresh) return cached;
        return (await this.find(clientId))?.conduitId ?? null;
    }

    /** The application, created on its first IDENTIFY. */
    public async findOrCreate(clientId: string): Promise<App> {
        const existing: App | null = await this.find(clientId);
        if (existing) return existing;

        const now: number = Date.now();
        const app: App = {
            clientId,
            botUserId: null,
            conduitId: null,
            hasAuthorizationSubscriptions: false,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
        };

        // Two IDENTIFYs at once may both get here – only one creates the record, the other reads it.
        const created: boolean = await this.redisClient.createIfNotExists(RedisKeys.twitch.app(clientId), app, RedisKeys.twitch.appsIndex(), clientId);
        if (created) {
            this.remember(clientId, app);
            return app;
        }

        const winner: App | null = await this.find(clientId);
        if (!winner) throw new MainError("APP_NOT_FOUND", `Application ${clientId} vanished right after it was created`);
        return winner;
    }

    /** Changes fields of an application (safe against concurrent changes). */
    public async update(clientId: string, patch: AppPatch): Promise<App | null> {
        return this.remember(clientId, await this.redisClient.updateJson(RedisKeys.twitch.app(clientId), appSchema, (app: App): App => ({
            ...app,
            ...patch,
            updatedAt: Date.now(),
        })));
    }

    /** Marks the application as used right now (IDENTIFY, or a session during the inactivity check). */
    public async markActive(clientId: string): Promise<void> {
        await this.update(clientId, {lastActiveAt: Date.now()});
    }

    /** Forgets the conduit of an app inactive since before `cutoff` – atomic, so an IDENTIFY in between wins. */
    public async deactivate(clientId: string, cutoff: number): Promise<string | null> {
        let removedConduitId: string | null = null;

        const app: App | null = await this.redisClient.updateJson(RedisKeys.twitch.app(clientId), appSchema, (current: App): App => {
            // Reset per attempt – updateJson runs this again if the record changed meanwhile.
            removedConduitId = null;
            if (!current.conduitId || (current.lastActiveAt ?? current.updatedAt) > cutoff) return current;

            removedConduitId = current.conduitId;
            // lastActiveAt stays – the retention period keeps counting from the last use.
            return {
                ...current,
                conduitId: null,
                hasAuthorizationSubscriptions: false,
                lastActiveAt: current.lastActiveAt ?? current.updatedAt,
                updatedAt: Date.now(),
            };
        });

        this.remember(clientId, app);
        return removedConduitId;
    }

    /** Deletes an app inactive since before `cutoff` with its token and users; the removed app, or null if it was used again. */
    public async removeInactive(clientId: string, cutoff: number): Promise<App | null> {
        const raw: unknown = await this.redisClient.evalScript(removeInactiveScript, [
            RedisKeys.twitch.app(clientId),
            RedisKeys.twitch.appToken(clientId),
            RedisKeys.twitch.appUsers(clientId),
            RedisKeys.twitch.appsIndex(),
        ], [String(cutoff), clientId]);

        const removed: App | null = this.redisClient.parse(raw, appSchema);
        // Unknown from now on – its webhooks are refused without a Redis call each.
        if (removed) this.conduitIds.set(clientId, null);
        return removed;
    }

    /** Keeps the conduit id in memory. */
    private remember(clientId: string, app: App | null): App | null {
        if (app) this.conduitIds.set(clientId, app.conduitId);
        return app;
    }

    /** Client ids of all applications. */
    public async getClientIds(): Promise<string[]> {
        return await this.redisClient.getSetMembers(RedisKeys.twitch.appsIndex());
    }

    /** The cached app access token of an application. */
    public async getToken(clientId: string): Promise<AppToken | null> {
        return await this.redisClient.get(RedisKeys.twitch.appToken(clientId), appTokenSchema);
    }

    /** Caches an app access token until it expires. */
    public async saveToken(clientId: string, token: AppToken, expiresInSeconds: number): Promise<void> {
        await this.redisClient.set<AppToken>(RedisKeys.twitch.appToken(clientId), token, expiresInSeconds);
    }

    /** User ids that authorized the application. */
    public async getAuthorizedUsers(clientId: string): Promise<string[]> {
        return await this.redisClient.getSetMembers(RedisKeys.twitch.appUsers(clientId));
    }

    /** Adds authorized users. */
    public async addAuthorizedUsers(clientId: string, ...userIds: string[]): Promise<void> {
        await this.redisClient.addToSet(RedisKeys.twitch.appUsers(clientId), ...userIds);
    }

    /** Removes a user that revoked the authorization. */
    public async removeAuthorizedUser(clientId: string, userId: string): Promise<void> {
        await this.redisClient.removeFromSet(RedisKeys.twitch.appUsers(clientId), userId);
    }
}
