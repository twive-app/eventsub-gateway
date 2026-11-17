import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test";
import type {GatewayPayload} from "@gateway/GatewayProtocol.ts";
import type {LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import {ConnectionStore, type ClaimResult} from "@gateway/connection/ConnectionStore.ts";
import {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import {SessionStore, type GatewaySessionData} from "@gateway/session/SessionStore.ts";
import {provideBean} from "../../../helpers.ts";
import {TestRedis} from "../../TestRedis.ts";

const app: string = "abc";

/** A live connection and the sequence numbers of the frames it was sent. */
interface Client {
    connection: LocalConnection;
    received: number[];
}

describe.skipIf(!TestRedis.available)("SessionDispatcher against Redis", (): void => {
    let redis: TestRedis;
    let connections: ConnectionStore;
    let sessions: SessionStore;
    let dispatcher: SessionDispatcher;
    // Connections the registry knows – a session whose connection is missing here is detached.
    let live: Map<string, Client>;

    /** A session with a live connection. */
    async function connect(connectionId: string, events: string[] | null = null): Promise<Client & {session: GatewaySessionData}> {
        await connections.createPending(connectionId, "203.0.113.5");
        const claim: ClaimResult = await connections.claimPending(connectionId);
        if (claim.status !== "claimed") throw new Error("not claimed");

        const session: GatewaySessionData = await sessions.create(app, events ? new Set<string>(events) : null, claim.pending);
        const client: Client = {
            received: [],
            connection: {connectionId, sessionId: session.sessionId, sequence: 0, pendingDeliveries: 0, delivery: Promise.resolve()} as unknown as LocalConnection,
        };
        live.set(connectionId, client);
        return {...client, session};
    }

    /** Waits until every client got `count` frames (dispatch is fire and forget). */
    async function settle(clients: Client[], count: number): Promise<void> {
        const deadline: number = Date.now() + 2000;
        while (clients.some((client: Client): boolean => client.received.length < count) && Date.now() < deadline) await Bun.sleep(5);
        // Anything sent twice would arrive now.
        await Bun.sleep(30);
    }

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        live = new Map<string, Client>();
        provideBean("appStore", {getClientIds: async (): Promise<string[]> => []});
        connections = new ConnectionStore();
        provideBean("connectionStore", connections);
        sessions = new SessionStore();
        provideBean("sessionStore", sessions);
        provideBean("connectionRegistry", {
            get: (connectionId: string): LocalConnection | undefined => live.get(connectionId)?.connection,
            send: (connection: LocalConnection, frame: GatewayPayload | string): boolean => {
                const payload: GatewayPayload = typeof frame === "string" ? JSON.parse(frame) as GatewayPayload : frame;
                live.get(connection.connectionId)?.received.push(payload.s ?? -1);
                return true;
            },
        });
        dispatcher = new SessionDispatcher();
    });

    afterEach(async (): Promise<void> => {
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("50 events in a row reach every connection once and in order", async (): Promise<void> => {
        const first: Client = await connect("c1");
        const second: Client = await connect("c2");

        for (let i: number = 0; i < 50; i++) dispatcher.dispatch(app, "CHANNEL_CHEER", {i});
        await settle([first, second], 50);

        const expected: number[] = Array.from({length: 50}, (_: unknown, i: number): number => i + 1);
        expect(first.received).toEqual(expected);
        expect(second.received).toEqual(expected);
    });

    test("a connection only gets the events of its filter, numbered without gaps", async (): Promise<void> => {
        const cheers: Client = await connect("c1", ["CHANNEL_CHEER"]);
        for (const event of ["CHANNEL_FOLLOW", "CHANNEL_CHEER", "CHANNEL_FOLLOW", "CHANNEL_CHEER"]) dispatcher.dispatch(app, event, {});
        await settle([cheers], 2);

        expect(cheers.received).toEqual([1, 2]);
    });

    test("a detached session gets nothing live, but finds every event in its replay buffer", async (): Promise<void> => {
        const client: Client & {session: GatewaySessionData} = await connect("c1");
        live.delete("c1");

        for (let i: number = 0; i < 3; i++) dispatcher.dispatch(app, "CHANNEL_CHEER", {i});
        await Bun.sleep(50);

        expect(client.received).toEqual([]);
        expect((await sessions.getBuffered(app, client.session.sessionId, 0, 4)).map((payload: GatewayPayload): number | null => payload.s)).toEqual([1, 2, 3]);
    });

    test("a gap – events dispatched while the connection was away – is filled from the buffer first", async (): Promise<void> => {
        const client: Client = await connect("c1");
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        await settle([client], 1);

        // Events 2 and 3 arrive while the registry doesn't know the connection (e.g. during a RESUME).
        live.delete("c1");
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        await Bun.sleep(50);
        live.set("c1", client);

        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        await settle([client], 4);

        expect(client.received).toEqual([1, 2, 3, 4]);
    });

    test("after a RESUME with replay nothing is sent twice", async (): Promise<void> => {
        const client: Client = await connect("c1");
        live.delete("c1");
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        await Bun.sleep(50);

        // GatewayHandler.resume sent the replay 1–2 and set the sequence.
        client.connection.sequence = 2;
        live.set("c1", client);
        dispatcher.dispatch(app, "CHANNEL_CHEER", {});
        await settle([client], 1);

        expect(client.received).toEqual([3]);
    });
});
