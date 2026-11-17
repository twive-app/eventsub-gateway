import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {ConnectionStore, type ClaimResult, type ConnectionState, type PendingConnection} from "@gateway/connection/ConnectionStore.ts";
import {SessionStore, type GatewaySessionData} from "@gateway/session/SessionStore.ts";
import {provideBean} from "../../../helpers.ts";
import {TestRedis} from "../../TestRedis.ts";

const app: string = "abc";

describe.skipIf(!TestRedis.available)("ConnectionStore against Redis", (): void => {
    let redis: TestRedis;
    let connections: ConnectionStore;
    let sessions: SessionStore;

    /** A pending connection, claimed. */
    async function claimed(connectionId: string): Promise<PendingConnection> {
        await connections.createPending(connectionId, "203.0.113.5");
        const claim: ClaimResult = await connections.claimPending(connectionId);
        if (claim.status !== "claimed") throw new Error(`could not claim ${connectionId}`);
        return claim.pending;
    }

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        provideBean("appStore", {getClientIds: async (): Promise<string[]> => []});
        connections = new ConnectionStore();
        provideBean("connectionStore", connections);
        sessions = new SessionStore();
    });

    afterEach(async (): Promise<void> => {
        setSystemTime();
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("a new connection is pending and expires after the identify timeout", async (): Promise<void> => {
        redis.configure({GATEWAY_IDENTIFY_TIMEOUT: "5000"});
        await connections.createPending("c1", "203.0.113.5");

        expect(await redis.json(RedisKeys.gateway.pendingConnection("c1"))).toMatchObject({connectionId: "c1", remoteAddress: "203.0.113.5", authenticating: false});
        expect(await redis.ttl(RedisKeys.gateway.pendingConnection("c1"))).toBeWithin(4000, 5001);
    });

    test("two IDENTIFYs on one connection at the same time: one is claimed, the other busy", async (): Promise<void> => {
        await connections.createPending("c1", "203.0.113.5");
        const claims: ClaimResult[] = await Promise.all([connections.claimPending("c1"), connections.claimPending("c1")]);

        expect(claims.map((claim: ClaimResult): string => claim.status).sort()).toEqual(["busy", "claimed"]);
    });

    test("without a pending entry (timeout over) the claim is expired", async (): Promise<void> => {
        expect(await connections.claimPending("c1")).toEqual({status: "expired"});
    });

    test("releasePending: after a failed IDENTIFY the client may try again", async (): Promise<void> => {
        const pending: PendingConnection = await claimed("c1");
        expect((await connections.claimPending("c1")).status).toBe("busy");

        await connections.releasePending(pending);
        expect((await connections.claimPending("c1")).status).toBe("claimed");
    });

    test("heartbeat records the time and renews the TTLs of connection and session", async (): Promise<void> => {
        const session: GatewaySessionData = await sessions.create(app, null, await claimed("c1"));
        const keys: string[] = [RedisKeys.gateway.connection(app, "c1"), RedisKeys.gateway.session(app, session.sessionId), RedisKeys.gateway.sessionSeq(app, session.sessionId)];
        for (const key of keys) await redis.raw.send("PEXPIRE", [key, "1000"]);

        setSystemTime(new Date(2026, 10, 17, 12, 0, 0));
        await connections.heartbeat(app, "c1", session.sessionId);

        expect(await redis.json(RedisKeys.gateway.connection(app, "c1"))).toMatchObject({lastHeartbeatAt: new Date(2026, 10, 17, 12, 0, 0).getTime()});
        // Connection: two heartbeat intervals; session: the attached TTL.
        expect(await redis.ttl(keys[0])).toBeWithin(80000, 82501);
        expect(await redis.ttl(keys[1])).toBeGreaterThan(200000);
        expect(await redis.ttl(keys[2])).toBeGreaterThan(200000);
    });

    test("a heartbeat of an unknown connection creates nothing", async (): Promise<void> => {
        await connections.heartbeat(app, "c1", crypto.randomUUID());
        expect(await redis.exists(RedisKeys.gateway.connection(app, "c1"))).toBe(false);
    });

    test("getStates: pending, gone and identified connections in one call", async (): Promise<void> => {
        await connections.createPending("pending", "203.0.113.5");
        const session: GatewaySessionData = await sessions.create(app, null, await claimed("identified"));

        const states: ConnectionState[] = await connections.getStates([
            {connectionId: "pending", clientId: null, sessionId: null},
            {connectionId: "gone", clientId: null, sessionId: null},
            {connectionId: "identified", clientId: app, sessionId: session.sessionId},
        ]);

        expect(states[0]).toEqual({status: "pending", exists: true});
        expect(states[1]).toEqual({status: "pending", exists: false});
        expect(states[2]).toMatchObject({status: "authenticated", connection: {connectionId: "identified", sessionId: session.sessionId}});
    });

    test("remove deletes the keys of a closed connection", async (): Promise<void> => {
        const session: GatewaySessionData = await sessions.create(app, null, await claimed("c1"));
        await connections.remove({connectionId: "c1", clientId: app, sessionId: session.sessionId});

        expect(await redis.exists(RedisKeys.gateway.connection(app, "c1"))).toBe(false);
        expect(await redis.exists(RedisKeys.gateway.pendingConnection("c1"))).toBe(false);
    });
});
