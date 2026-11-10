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
    createdAt: z.number(),
    updatedAt: z.number(),
});

/** An application (Twitch client id) the gateway manages: bot user, conduit and setup state. */
export interface App {
    clientId: string;
    botUserId: string | null;
    conduitId: string | null;
    hasAuthorizationSubscriptions: boolean;
    createdAt: number;
    updatedAt: number;
}

/** Fields of an application that may change. */
type AppPatch = Partial<Pick<App, "botUserId" | "conduitId" | "hasAuthorizationSubscriptions">>;

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
