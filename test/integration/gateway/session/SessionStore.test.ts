import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {GatewayProtocol, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import {ConnectionStore, type ClaimResult, type PendingConnection} from "@gateway/connection/ConnectionStore.ts";
import {SessionStore, type AttachedSession, type DispatchTarget, type GatewaySessionData} from "@gateway/session/SessionStore.ts";
import {provideBean} from "../../../helpers.ts";
import {TestRedis} from "../../TestRedis.ts";

const app: string = "abc";
// Defaults: heartbeat 41.25 s, resume timeout 120 s → an attached session lives 202.5 s.
const attachedTtl: number = 120000 + 41250 * 2;

describe.skipIf(!TestRedis.available)("SessionStore against Redis", (): void => {
    let redis: TestRedis;
    let connections: ConnectionStore;
    let sessions: SessionStore;
    let clientIds: string[];

    /** A connection that sent IDENTIFY/RESUME: pending in Redis and claimed. */
    async function claimed(connectionId: string): Promise<PendingConnection> {
        await connections.createPending(connectionId, "203.0.113.5");
        const claim: ClaimResult = await connections.claimPending(connectionId);
        if (claim.status !== "claimed") throw new Error(`could not claim ${connectionId}: ${claim.status}`);
        return claim.pending;
    }

    /** A session identified on this connection. */
    async function identified(connectionId: string, events: string[] | null = null): Promise<GatewaySessionData> {
        return await sessions.create(app, events ? new Set<string>(events) : null, await claimed(connectionId));
    }

    /** The replay buffer as stored. */
    async function buffer(sessionId: string): Promise<GatewayPayload[]> {
        const raw: string[] = await redis.raw.send("LRANGE", [RedisKeys.gateway.sessionBuffer(app, sessionId), "0", "-1"]) as string[];
        return raw.map((entry: string): GatewayPayload => JSON.parse(entry) as GatewayPayload);
    }

    /** Dispatches an event and returns session → sequence number of every target. */
    async function dispatch(eventName: string, data: unknown = {}): Promise<Record<string, number | null>> {
        const targets: DispatchTarget[] = await sessions.dispatch(app, eventName, JSON.stringify(data));
        return Object.fromEntries(targets.map((target: DispatchTarget): [string, number | null] => [target.sessionId, target.sequence]));
    }

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        clientIds = [app];
        provideBean("appStore", {getClientIds: async (): Promise<string[]> => clientIds});
        connections = new ConnectionStore();
        provideBean("connectionStore", connections);
        sessions = new SessionStore();
    });

    afterEach(async (): Promise<void> => {
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("create: session, sequence 0 and index entry with the attached TTL; the connection is identified", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1", ["CHANNEL_CHEER"]);

        expect(await redis.json(RedisKeys.gateway.session(app, session.sessionId))).toMatchObject({clientId: app, events: ["CHANNEL_CHEER"], connectionId: "c1"});
        expect(await redis.raw.get(RedisKeys.gateway.sessionSeq(app, session.sessionId))).toBe("0");
        expect(await redis.client.getSetMembers(RedisKeys.gateway.sessionsIndex(app))).toEqual([session.sessionId]);
        expect(await redis.ttl(RedisKeys.gateway.session(app, session.sessionId))).toBeWithin(attachedTtl - 2000, attachedTtl + 1);

        expect(await redis.exists(RedisKeys.gateway.pendingConnection("c1"))).toBe(false);
        expect(await redis.json(RedisKeys.gateway.connection(app, "c1"))).toMatchObject({connectionId: "c1", sessionId: session.sessionId});
    });

    test("dispatch: own sequence numbers per session, the event filter and the replay buffer", async (): Promise<void> => {
        const all: GatewaySessionData = await identified("c1");
        const cheers: GatewaySessionData = await identified("c2", ["CHANNEL_CHEER"]);

        expect(await dispatch("CHANNEL_FOLLOW")).toEqual({[all.sessionId]: 1});
        expect(await dispatch("CHANNEL_CHEER", {bits: 100})).toEqual({[all.sessionId]: 2, [cheers.sessionId]: 1});

        expect((await buffer(all.sessionId)).map((payload: GatewayPayload): string | null => payload.t)).toEqual(["CHANNEL_FOLLOW", "CHANNEL_CHEER"]);
        // Byte for byte what the connection is sent live.
        const [stored]: string[] = await redis.raw.send("LRANGE", [RedisKeys.gateway.sessionBuffer(app, cheers.sessionId), "0", "-1"]) as string[];
        expect(stored).toBe(GatewayProtocol.serializeDispatch("CHANNEL_CHEER", JSON.stringify({bits: 100}), 1));
    });

    test("the replay buffer keeps the last GATEWAY_REPLAY_BUFFER_SIZE events and the session's TTL", async (): Promise<void> => {
        redis.configure({GATEWAY_REPLAY_BUFFER_SIZE: "3"});
        const session: GatewaySessionData = await identified("c1");
        for (let i: number = 0; i < 5; i++) await dispatch("CHANNEL_CHEER", {i});

        expect((await buffer(session.sessionId)).map((payload: GatewayPayload): number | null => payload.s)).toEqual([3, 4, 5]);
        expect(await redis.ttl(RedisKeys.gateway.sessionBuffer(app, session.sessionId))).toBeWithin(attachedTtl - 2000, attachedTtl + 1);
        // Too far behind: RESUME from 1 isn't possible anymore.
        expect(SessionStore.getReplay(await buffer(session.sessionId), 1, 5)).toBeNull();
    });

    test("READY and RESUMED: no sequence number, no buffer, no filter", async (): Promise<void> => {
        const cheers: GatewaySessionData = await identified("c1", ["CHANNEL_CHEER"]);

        expect(await dispatch("RESUMED")).toEqual({[cheers.sessionId]: null});
        expect(await buffer(cheers.sessionId)).toEqual([]);
        expect(await redis.raw.get(RedisKeys.gateway.sessionSeq(app, cheers.sessionId))).toBe("0");
    });

    test("an expired session is dropped from the index by the next dispatch", async (): Promise<void> => {
        const expired: GatewaySessionData = await identified("c1");
        const alive: GatewaySessionData = await identified("c2");
        await redis.raw.del(RedisKeys.gateway.session(app, expired.sessionId));

        expect(await dispatch("CHANNEL_CHEER")).toEqual({[alive.sessionId]: 1});
        expect(await redis.client.getSetMembers(RedisKeys.gateway.sessionsIndex(app))).toEqual([alive.sessionId]);
    });

    test("detach: the session waits for RESUME with the resume timeout and keeps buffering", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        await sessions.detach(app, session.sessionId, "c1");

        expect(await redis.json(RedisKeys.gateway.session(app, session.sessionId))).toMatchObject({connectionId: null, events: null});
        for (const key of [RedisKeys.gateway.session(app, session.sessionId), RedisKeys.gateway.sessionSeq(app, session.sessionId)]) {
            expect(await redis.ttl(key)).toBeWithin(118000, 120001);
        }

        const targets: DispatchTarget[] = await sessions.dispatch(app, "CHANNEL_CHEER", "{}");
        expect(targets).toEqual([{sessionId: session.sessionId, connectionId: "", sequence: 1}]);
        expect(await buffer(session.sessionId)).toHaveLength(1);
    });

    test("detach of a connection that no longer owns the session changes nothing", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        await sessions.detach(app, session.sessionId, "c-old");

        expect(await redis.json(RedisKeys.gateway.session(app, session.sessionId))).toMatchObject({connectionId: "c1"});
        expect(await redis.ttl(RedisKeys.gateway.session(app, session.sessionId))).toBeGreaterThan(120001);
    });

    test("with GATEWAY_RESUME_TIMEOUT=0 detach ends the session right away", async (): Promise<void> => {
        redis.configure({GATEWAY_RESUME_TIMEOUT: "0"});
        const session: GatewaySessionData = await identified("c1");
        await sessions.detach(app, session.sessionId, "c1");

        expect(await redis.exists(RedisKeys.gateway.session(app, session.sessionId))).toBe(false);
        expect(await redis.exists(RedisKeys.gateway.sessionSeq(app, session.sessionId))).toBe(false);
        expect(await redis.client.getSetMembers(RedisKeys.gateway.sessionsIndex(app))).toEqual([]);
    });

    test("attach (RESUME): the new connection takes over and gets the buffer and the previous connection", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        await dispatch("CHANNEL_CHEER", {n: 1});
        await dispatch("CHANNEL_CHEER", {n: 2});
        await sessions.detach(app, session.sessionId, "c1");

        const attached: AttachedSession | null = await sessions.attach(app, session.sessionId, await claimed("c2"));

        expect(attached?.previousConnectionId).toBeNull();
        expect(attached?.buffer.map((payload: GatewayPayload): unknown => payload.d)).toEqual([{n: 1}, {n: 2}]);
        expect(await redis.json(RedisKeys.gateway.session(app, session.sessionId))).toMatchObject({connectionId: "c2"});
        // Back to the TTL of an attached session, and c2 is identified.
        expect(await redis.ttl(RedisKeys.gateway.session(app, session.sessionId))).toBeWithin(attachedTtl - 2000, attachedTtl + 1);
        expect(await redis.exists(RedisKeys.gateway.connection(app, "c2"))).toBe(true);
        expect(await redis.exists(RedisKeys.gateway.pendingConnection("c2"))).toBe(false);
    });

    test("attach while the old connection still holds the session names it, so it can be replaced", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        const attached: AttachedSession | null = await sessions.attach(app, session.sessionId, await claimed("c2"));

        expect(attached?.previousConnectionId).toBe("c1");
        // The old connection can't end the session anymore – it belongs to c2 now.
        await sessions.destroyOwned(app, session.sessionId, "c1");
        expect(await redis.exists(RedisKeys.gateway.session(app, session.sessionId))).toBe(true);
    });

    test("attach of an unknown session is null", async (): Promise<void> => {
        expect(await sessions.attach(app, crypto.randomUUID(), await claimed("c1"))).toBeNull();
    });

    test("abandonResume: the session is gone, the connection is pending again and may IDENTIFY", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        await sessions.detach(app, session.sessionId, "c1");
        const pending: PendingConnection = await claimed("c2");
        await sessions.attach(app, session.sessionId, pending);

        await sessions.abandonResume(app, session.sessionId, pending);

        expect(await redis.exists(RedisKeys.gateway.session(app, session.sessionId))).toBe(false);
        expect(await redis.client.getSetMembers(RedisKeys.gateway.sessionsIndex(app))).toEqual([]);
        expect(await redis.exists(RedisKeys.gateway.connection(app, "c2"))).toBe(false);
        expect((await connections.claimPending("c2")).status).toBe("claimed");
    });

    test("hasSessions: false once every session expired – and the index is cleaned up", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");
        expect(await sessions.hasSessions(app)).toBe(true);

        await redis.raw.del(RedisKeys.gateway.session(app, session.sessionId));
        expect(await sessions.hasSessions(app)).toBe(false);
        expect(await redis.client.getSetMembers(RedisKeys.gateway.sessionsIndex(app))).toEqual([]);
    });

    test("on startup the sessions of the previous run are detached, so their clients can RESUME", async (): Promise<void> => {
        const session: GatewaySessionData = await identified("c1");

        // A new process: its SessionStore starts up.
        const restarted: SessionStore = new SessionStore();
        restarted.initialize();

        const deadline: number = Date.now() + 2000;
        while ((await redis.json<GatewaySessionData>(RedisKeys.gateway.session(app, session.sessionId)))?.connectionId !== null && Date.now() < deadline) {
            await Bun.sleep(10);
        }
        expect(await redis.json(RedisKeys.gateway.session(app, session.sessionId))).toMatchObject({connectionId: null});
        expect(redis.logger.messages("success")).toContain("Sessions of the previous run detached, clients can RESUME");
    });
});
