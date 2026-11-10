/** Every Redis key – `twitch:*` belongs to src/twitch, `gateway:*` to src/gateway; no key is the prefix of another. */
export const RedisKeys = {
    // Applications, their tokens and users, webhook de-duplication.
    twitch: {
        /** SET of all client ids. */
        appsIndex(): string {
            return "twitch:apps:index";
        },

        /** JSON record of an application (bot, conduit, flags). */
        app(clientId: string): string {
            return `twitch:apps:${clientId}:app`;
        },

        /** JSON app access token with the hash of the secret (TTL = token lifetime). */
        appToken(clientId: string): string {
            return `twitch:apps:${clientId}:token`;
        },

        /** SET of the user ids that authorized the application. */
        appUsers(clientId: string): string {
            return `twitch:apps:${clientId}:users`;
        },

        /** Marker of a delivered webhook message (TTL 10 min). */
        eventSubMessage(messageId: string): string {
            return `twitch:eventsub:messages:${messageId}`;
        },
    },
    // Sessions, connections and per-connection limits.
    gateway: {
        /** SET of the session ids of an application. */
        sessionsIndex(clientId: string): string {
            return `gateway:apps:${clientId}:sessions:index`;
        },

        /** JSON record of a session (events, connection). */
        session(clientId: string, sessionId: string): string {
            return `gateway:apps:${clientId}:sessions:${sessionId}:session`;
        },

        /** Last sequence number of a session. */
        sessionSeq(clientId: string, sessionId: string): string {
            return `gateway:apps:${clientId}:sessions:${sessionId}:seq`;
        },

        /** LIST of the last dispatches of a session, replayed on RESUME. */
        sessionBuffer(clientId: string, sessionId: string): string {
            return `gateway:apps:${clientId}:sessions:${sessionId}:buffer`;
        },

        /** JSON record of an identified connection (last heartbeat). */
        connection(clientId: string, connectionId: string): string {
            return `gateway:apps:${clientId}:connections:${connectionId}`;
        },

        /** JSON record of a connection that hasn't sent IDENTIFY/RESUME yet (TTL = identify timeout). */
        pendingConnection(connectionId: string): string {
            return `gateway:pending:${connectionId}`;
        },

        /** Message counter of a connection for the rate limit (TTL = window). */
        rateLimit(connectionId: string): string {
            return `gateway:ratelimit:${connectionId}`;
        },
    },
} as const;
