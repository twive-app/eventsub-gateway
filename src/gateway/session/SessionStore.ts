import crypto from "node:crypto";
import z from "zod";
import {Autowired, Bean, PostConstruct} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {RedisClient} from "@core/redis/RedisClient.ts";
import type {RedisClientTransaction} from "@core/redis/RedisClient.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {GatewayOpCode, GatewayProtocol, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import type {ConnectionStore, PendingConnection} from "@gateway/connection/ConnectionStore.ts";
import type {AppStore} from "@twitch/app/AppStore.ts";

const gatewaySessionSchema = z.object({
    sessionId: z.string(),
    clientId: z.string(),
    events: z.array(z.string()).nullable(),
    createdAt: z.number(),
    connectionId: z.string().nullable(),
});

/** A session: its app, event filter and the connection it is attached to (null = waiting for RESUME). */
export interface GatewaySessionData {
    sessionId: string;
    clientId: string;
    events: string[] | null;
    createdAt: number;
    connectionId: string | null;
}

/** Session counts for /health. */
export interface GatewayStats {
    sessions: number;
    applications: number;
}

/** A session an event was dispatched to: its connection ("" if detached) and sequence number. */
export interface DispatchTarget {
    sessionId: string;
    connectionId: string;
    sequence: number | null;
}

/** Result of attaching a session on RESUME: the replay buffer and the connection that held it before. */
export interface AttachedSession {
    buffer: GatewayPayload[];
    previousConnectionId: string | null;
}

const sequenceSchema = z.number().int().min(0);
const payloadSchema = z.object({
    op: z.number(),
    d: z.unknown(),
    s: z.number().nullable(),
    t: z.string().nullable(),
});

// Fans one event out to every session of an app: filter, sequence number and replay buffer, atomically.
const dispatchScript: string = `
local results = {}
local sequenced = ARGV[3] == "1"
local bufferSize = tonumber(ARGV[4])
local count = (#KEYS - 1) / 3
local payloadHead = '{"op":${GatewayOpCode.Dispatch},"d":' .. ARGV[2] .. ',"s":'
local payloadTail = ',"t":' .. cjson.encode(ARGV[1]) .. '}'
for i = 1, count do
    local session, seqKey, bufferKey = KEYS[i * 3 - 1], KEYS[i * 3], KEYS[i * 3 + 1]
    local sessionId = ARGV[4 + i]
    local raw = redis.call("GET", session)
    if not raw then
        -- the session expired: drop it from the index
        redis.call("SREM", KEYS[1], sessionId)
    else
        local data = cjson.decode(raw)
        local wants = (not sequenced) or data.events == cjson.null or data.events == nil
        if not wants then
            for _, event in ipairs(data.events) do
                if event == ARGV[1] then wants = true break end
            end
        end
        if wants then
            local seq = 0
            if sequenced then
                -- next sequence number, and into the replay buffer (trimmed to its size)
                seq = redis.call("INCR", seqKey)
                if bufferSize > 0 then
                    local length = redis.call("RPUSH", bufferKey, payloadHead .. seq .. payloadTail)
                    if length > bufferSize then redis.call("LTRIM", bufferKey, -bufferSize, -1) end
                    -- a new buffer gets the TTL of its session
                    if length == 1 then
                        local ttl = redis.call("PTTL", session)
                        if ttl > 0 then redis.call("PEXPIRE", bufferKey, ttl) end
                    end
                end
            end
            local connectionId = data.connectionId
            if connectionId == cjson.null or connectionId == nil then connectionId = "" end
            table.insert(results, sessionId)
            table.insert(results, connectionId)
            table.insert(results, seq)
        end
    end
end
return results
`;

// Sets connectionId to null and the resume TTL – only if the session still belongs to that connection.
const detachScript: string = `
local raw = redis.call("GET", KEYS[1])
if not raw or cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
local from, to = string.find(raw, '"connectionId":"' .. ARGV[1] .. '"', 1, true)
if not from then return 0 end
redis.call("SET", KEYS[1], string.sub(raw, 1, from - 1) .. '"connectionId":null' .. string.sub(raw, to + 1), "PX", ARGV[2])
redis.call("PEXPIRE", KEYS[2], ARGV[2])
redis.call("PEXPIRE", KEYS[3], ARGV[2])
return 1
`;

// Deletes a session – only if it still belongs to that connection (it may have been resumed elsewhere).
const destroyOwnedScript: string = `
local raw = redis.call("GET", KEYS[1])
if not raw or cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
redis.call("SREM", KEYS[4], ARGV[2])
return 1
`;

/** Owns the session keys in Redis: sessions, sequence numbers, replay buffers and the session index. */
@Bean()
export class SessionStore {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private redisClient!: RedisClient;

    @Autowired()
    private connectionStore!: ConnectionStore;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private errorReporter!: ErrorReporter;

    @Autowired()
    private logger!: Logger;

    /** TTL of an attached session: the resume timeout plus two heartbeat intervals, renewed by every heartbeat. */
    public static attachedTtlMs(gateway: ConfigValues["gateway"]): number {
        return gateway.resumeTimeout + gateway.heartbeatInterval * 2;
    }

    /** Events after seq, or null if the buffer doesn't reach back that far (a gap means RESUME can't work). */
    public static getReplay(buffer: GatewayPayload[], seq: number, sequence: number): GatewayPayload[] | null {
        const missed: GatewayPayload[] = buffer.filter((payload: GatewayPayload): boolean => (payload.s ?? 0) > seq);
        if (missed.length === 0) return seq >= sequence ? [] : null;
        return missed[0].s === seq + 1 ? missed : null;
    }

    /** On startup: the connections of the previous process are gone, their sessions become resumable. */
    @PostConstruct()
    public initialize(): void {
        this.detachOrphanedSessions().catch((error: unknown): void => {
            this.logger.warning("SESSION", "Could not detach the sessions of closed connections");
            this.errorReporter.handle(error);
        });
    }

    /** Buffered events between two sequence numbers – fills a gap when a dispatch overtook a RESUME. */
    public async getBuffered(clientId: string, sessionId: string, after: number, before: number): Promise<GatewayPayload[]> {
        const [raw]: unknown[] = await this.redisClient.pipeline((multi: RedisClientTransaction): void => {
            multi.lRange(RedisKeys.gateway.sessionBuffer(clientId, sessionId), 0, -1);
        });
        return this.parseBuffer(raw).filter((payload: GatewayPayload): boolean => (payload.s ?? 0) > after && (payload.s ?? 0) < before);
    }

    /** Creates a session for an identified connection (READY). */
    public async create(clientId: string, events: Set<string> | null, pending: PendingConnection): Promise<GatewaySessionData> {
        const session: GatewaySessionData = {
            sessionId: crypto.randomUUID(),
            clientId,
            events: events ? [...events] : null,
            createdAt: Date.now(),
            connectionId: pending.connectionId,
        };
        const ttl: number = this.attachedTtlMs();

        await this.redisClient.transaction((multi: RedisClientTransaction): void => {
            multi.set(RedisKeys.gateway.session(clientId, session.sessionId), JSON.stringify(session), {expiration: {type: "PX", value: ttl}});
            multi.set(RedisKeys.gateway.sessionSeq(clientId, session.sessionId), "0", {expiration: {type: "PX", value: ttl}});
            multi.sAdd(RedisKeys.gateway.sessionsIndex(clientId), session.sessionId);
            this.connectionStore.addPromotion(multi, pending, clientId, session.sessionId);
        });

        return session;
    }

    /** Last sequence number of a session, or null if it doesn't exist. */
    public async getSequence(clientId: string, sessionId: string): Promise<number | null> {
        return await this.redisClient.get(RedisKeys.gateway.sessionSeq(clientId, sessionId), sequenceSchema);
    }

    /** Attaches a session to a resuming connection and returns its replay buffer. */
    public async attach(clientId: string, sessionId: string, pending: PendingConnection): Promise<AttachedSession | null> {
        let previousConnectionId: string | null = null;
        const attached: GatewaySessionData | null = await this.redisClient.updateJson(
            RedisKeys.gateway.session(clientId, sessionId),
            gatewaySessionSchema,
            (session: GatewaySessionData): GatewaySessionData => {
                previousConnectionId = session.connectionId;
                return {...session, connectionId: pending.connectionId};
            },
        );
        if (!attached) return null;

        // Back to the TTL of an attached session.
        const ttl: number = this.attachedTtlMs();
        const replies: unknown[] = await this.redisClient.transaction((multi: RedisClientTransaction): void => {
            multi.lRange(RedisKeys.gateway.sessionBuffer(clientId, sessionId), 0, -1);
            for (const key of this.sessionKeys(clientId, sessionId)) multi.pExpire(key, ttl);
            this.connectionStore.addPromotion(multi, pending, clientId, sessionId);
        });

        return {buffer: this.parseBuffer(replies[0]), previousConnectionId};
    }

    /** RESUME failed after attaching: delete the session, the connection is pending again. */
    public async abandonResume(clientId: string, sessionId: string, pending: PendingConnection): Promise<void> {
        await this.redisClient.transaction((multi: RedisClientTransaction): void => {
            this.addDestroy(multi, clientId, sessionId);
            this.connectionStore.addDemotion(multi, pending, clientId);
        });
    }

    /** The connection closed: the session waits for RESUME for the resume timeout (0 = delete it right away). */
    public async detach(clientId: string, sessionId: string, connectionId: string): Promise<void> {
        const resumeTimeout: number = this.configManager.get().gateway.resumeTimeout;
        if (resumeTimeout <= 0) return await this.destroyOwned(clientId, sessionId, connectionId);

        await this.redisClient.evalScript(detachScript, this.sessionKeys(clientId, sessionId), [connectionId, String(resumeTimeout)]);
    }

    /** Ends a session if it still belongs to that connection (close with a session-ending code). */
    public async destroyOwned(clientId: string, sessionId: string, connectionId: string): Promise<void> {
        await this.redisClient.evalScript(
            destroyOwnedScript,
            [...this.sessionKeys(clientId, sessionId), RedisKeys.gateway.sessionsIndex(clientId)],
            [connectionId, sessionId],
        );
    }

    /** Deletes a session unconditionally. */
    public async destroy(clientId: string, sessionId: string): Promise<void> {
        await this.redisClient.transaction((multi: RedisClientTransaction): void => this.addDestroy(multi, clientId, sessionId));
    }

    /** Dispatches an event to every session of an app and returns the connections to send it to. */
    public async dispatch(clientId: string, eventName: string, data: unknown): Promise<DispatchTarget[]> {
        const sessionIds: string[] = await this.getSessionIds(clientId);
        if (sessionIds.length === 0) return [];

        // READY and RESUMED have no sequence number and are never buffered.
        const sequenced: boolean = !GatewayProtocol.lifecycleEvents.has(eventName);
        const keys: string[] = [RedisKeys.gateway.sessionsIndex(clientId)];
        for (const sessionId of sessionIds) keys.push(...this.sessionKeys(clientId, sessionId));

        const reply: unknown = await this.redisClient.evalScript(dispatchScript, keys, [
            eventName,
            JSON.stringify(data ?? null),
            sequenced ? "1" : "0",
            String(this.configManager.get().gateway.replayBufferSize),
            ...sessionIds,
        ]);

        const results: unknown[] = Array.isArray(reply) ? reply : [];
        const targets: DispatchTarget[] = [];
        for (let i: number = 0; i + 2 < results.length; i += 3) {
            targets.push({
                sessionId: String(results[i]),
                connectionId: String(results[i + 1]),
                sequence: sequenced ? Number(results[i + 2]) : null,
            });
        }
        return targets;
    }

    /** Number of sessions and of applications with at least one session. */
    public async getStats(clientIds: string[]): Promise<GatewayStats> {
        const counts: unknown[] = await this.redisClient.pipeline((multi: RedisClientTransaction): void => {
            for (const clientId of clientIds) multi.sCard(RedisKeys.gateway.sessionsIndex(clientId));
        });

        const sessionCounts: number[] = counts.map((count: unknown): number => Number(count));
        return {
            sessions: sessionCounts.reduce((sum: number, count: number): number => sum + count, 0),
            applications: sessionCounts.filter((count: number): boolean => count > 0).length,
        };
    }

    /** Ids in the session index of an app. */
    private async getSessionIds(clientId: string): Promise<string[]> {
        return await this.redisClient.getSetMembers(RedisKeys.gateway.sessionsIndex(clientId));
    }

    /** Several sessions in one round trip; missing ones are null. */
    private async getSessions(clientId: string, sessionIds: string[]): Promise<(GatewaySessionData | null)[]> {
        return await this.redisClient.mGet(sessionIds.map((sessionId: string): string => RedisKeys.gateway.session(clientId, sessionId)), gatewaySessionSchema);
    }

    /** Removes ids from the session index of an app. */
    private async removeFromIndex(clientId: string, ...sessionIds: string[]): Promise<void> {
        await this.redisClient.removeFromSet(RedisKeys.gateway.sessionsIndex(clientId), ...sessionIds);
    }

    /** Attached TTL with the current configuration. */
    private attachedTtlMs(): number {
        return SessionStore.attachedTtlMs(this.configManager.get().gateway);
    }

    /** Parses the raw replay buffer; invalid entries are skipped. */
    private parseBuffer(raw: unknown): GatewayPayload[] {
        return (Array.isArray(raw) ? raw as unknown[] : [])
            .map((entry: unknown): GatewayPayload | null => this.redisClient.parse(entry, payloadSchema) as GatewayPayload | null)
            .filter((payload: GatewayPayload | null): payload is GatewayPayload => payload !== null);
    }

    /** Detaches every session still attached to a connection of the previous process and drops expired ids. */
    private async detachOrphanedSessions(): Promise<void> {
        const clientIds: string[] = await this.appStore.getClientIds();
        let detached: number = 0;

        for (const clientId of clientIds) {
            const sessionIds: string[] = await this.getSessionIds(clientId);
            const sessions: (GatewaySessionData | null)[] = await this.getSessions(clientId, sessionIds);

            const expired: string[] = sessionIds.filter((_sessionId: string, index: number): boolean => sessions[index] === null);
            await this.removeFromIndex(clientId, ...expired);

            for (const session of sessions) {
                if (!session?.connectionId) continue;

                await this.detach(clientId, session.sessionId, session.connectionId);
                detached++;
            }
        }

        if (detached > 0) this.logger.info("SESSION", `Detached ${detached} session(s) of closed connections, they can RESUME`);
    }

    /** Adds the deletion of a session and its index entry to a transaction. */
    private addDestroy(multi: RedisClientTransaction, clientId: string, sessionId: string): void {
        multi.del(this.sessionKeys(clientId, sessionId));
        multi.sRem(RedisKeys.gateway.sessionsIndex(clientId), sessionId);
    }

    /** The three keys of a session: record, sequence number, replay buffer. */
    private sessionKeys(clientId: string, sessionId: string): string[] {
        return [RedisKeys.gateway.session(clientId, sessionId), RedisKeys.gateway.sessionSeq(clientId, sessionId), RedisKeys.gateway.sessionBuffer(clientId, sessionId)];
    }
}
