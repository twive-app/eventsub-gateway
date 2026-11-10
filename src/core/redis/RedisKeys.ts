// Optional REDIS_KEY_PREFIX – set once on startup by RedisClient; empty = keys start with twitch:/gateway:.
let keyPrefix: string = "";

/** A key with the configured prefix in front, e.g. "twive:twitch:apps:index". */
function withPrefix(key: string): string {
    return keyPrefix ? `${keyPrefix}:${key}` : key;
}

/** Every Redis key – `twitch:*` belongs to src/twitch, `gateway:*` to src/gateway; no key is the prefix of another. */
export const RedisKeys = {
    /** Sets the prefix of every key (REDIS_KEY_PREFIX) – called once before Redis is used. */
    setPrefix(prefix: string): void {
        keyPrefix = prefix;
    },

    // Applications, their tokens and users, webhook de-duplication.
    twitch: {
        /** SET of all client ids. */
        appsIndex(): string {
            return withPrefix("twitch:apps:index");
        },

        /** JSON record of an application (bot, conduit, flags). */
        app(clientId: string): string {
            return withPrefix(`twitch:apps:${clientId}:app`);
        },

        /** JSON app access token with the hash of the secret (TTL = token lifetime). */
        appToken(clientId: string): string {
            return withPrefix(`twitch:apps:${clientId}:token`);
        },

        /** SET of the user ids that authorized the application. */
        appUsers(clientId: string): string {
            return withPrefix(`twitch:apps:${clientId}:users`);
        },

        /** Marker of a delivered webhook message (TTL 10 min). */
        eventSubMessage(messageId: string): string {
            return withPrefix(`twitch:eventsub:messages:${messageId}`);
        },
    },
    // Sessions, connections and per-connection limits.
    gateway: {
        /** SET of the session ids of an application. */
        sessionsIndex(clientId: string): string {
            return withPrefix(`gateway:apps:${clientId}:sessions:index`);
        },

        /** JSON record of a session (events, connection). */
        session(clientId: string, sessionId: string): string {
            return withPrefix(`gateway:apps:${clientId}:sessions:${sessionId}:session`);
        },

        /** Last sequence number of a session. */
        sessionSeq(clientId: string, sessionId: string): string {
            return withPrefix(`gateway:apps:${clientId}:sessions:${sessionId}:seq`);
        },

        /** LIST of the last dispatches of a session, replayed on RESUME. */
        sessionBuffer(clientId: string, sessionId: string): string {
            return withPrefix(`gateway:apps:${clientId}:sessions:${sessionId}:buffer`);
        },

        /** JSON record of an identified connection (last heartbeat). */
        connection(clientId: string, connectionId: string): string {
            return withPrefix(`gateway:apps:${clientId}:connections:${connectionId}`);
        },

        /** JSON record of a connection that hasn't sent IDENTIFY/RESUME yet (TTL = identify timeout). */
        pendingConnection(connectionId: string): string {
            return withPrefix(`gateway:pending:${connectionId}`);
        },

        /** Message counter of a connection for the rate limit (TTL = window). */
        rateLimit(connectionId: string): string {
            return withPrefix(`gateway:ratelimit:${connectionId}`);
        },
    },
} as const;
