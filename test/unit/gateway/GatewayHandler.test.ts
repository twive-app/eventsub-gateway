import {beforeEach, describe, expect, test} from "bun:test";
import {HttpProxyService} from "@core/http/HttpProxyService.ts";
import {GatewayHandler} from "@gateway/GatewayHandler.ts";
import {GatewayCloseCode, GatewayOpCode, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import {AuthFailureLimiter} from "@twitch/app/AuthFailureLimiter.ts";
import type {LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import type {ClaimResult, ConnectionRef, PendingConnection} from "@gateway/connection/ConnectionStore.ts";
import type {AttachedSession, GatewaySessionData} from "@gateway/session/SessionStore.ts";
import type {AppCredentialsResult} from "@twitch/app/AppAuthenticator.ts";
import type {BotUserUpdate} from "@twitch/app/AppBotUserService.ts";
import type {App} from "@twitch/app/AppStore.ts";
import {loadConfig, provideBean} from "../../helpers.ts";
import {ConfigManagerMockup} from "../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../mockups/LoggerMockup.ts";

const clientId: string = "abc";
const sessionId: string = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const address: string = "203.0.113.5";

/** What the handler did to one connection. */
interface Outcome {
    open: boolean;
    closed: {code: number; reason: string} | null;
    sent: GatewayPayload[];
    invalidSessions: string[];
}

/** A connection that hasn't sent IDENTIFY or RESUME yet. */
interface TestConnection extends Outcome {
    connection: LocalConnection;
}

const app: App = {clientId, botUserId: null, conduitId: "conduit-1", hasAuthorizationSubscriptions: true, lastActiveAt: null, createdAt: 0, updatedAt: 0};
const pending: PendingConnection = {connectionId: "c1", remoteAddress: address, connectedAt: 0, authenticating: true};

let connections: Map<string, TestConnection>;
let handler: GatewayHandler;
let credentials: AppCredentialsResult;
let credentialRequests: number;
let claim: () => Promise<ClaimResult>;
let botUser: BotUserUpdate | null;
let setupResult: App | null;
let sequence: number | null;
let attached: AttachedSession | null;
let onSessionCreated: () => void;
let released: number;
let destroyed: string[];
let abandoned: number;
let replaced: string[];

/** A new open connection of `address`. */
function connect(connectionId: string = "c1"): TestConnection {
    const outcome: TestConnection = {
        open: true,
        closed: null,
        sent: [],
        invalidSessions: [],
        connection: {
            connectionId,
            clientId: null,
            sessionId: null,
            socket: {data: {connectionId, remoteAddress: address, socketAddress: address, rejection: null}},
            sequence: 0,
            lastHeartbeatAt: 0,
            authenticating: false,
        } as unknown as LocalConnection,
    };
    connections.set(connectionId, outcome);
    return outcome;
}

/** The test connection behind a LocalConnection. */
function of(connection: LocalConnection): TestConnection {
    const outcome: TestConnection | undefined = connections.get(connection.connectionId);
    if (!outcome) throw new Error(`Unknown connection ${connection.connectionId}`);
    return outcome;
}

/** A DISPATCH as the session buffer holds it. */
function dispatch(seq: number): GatewayPayload {
    return {op: GatewayOpCode.Dispatch, d: {seq}, s: seq, t: "CHANNEL_CHEER"};
}

/** Wires a fresh handler; the limit manager is real, everything with Redis or Twitch is a stand-in. */
function wire(env: Record<string, string> = {}): void {
    provideBean("configManager", new ConfigManagerMockup(loadConfig(env)));
    provideBean("logger", new LoggerMockup());
    provideBean("httpProxyService", new HttpProxyService());
    provideBean("connectionLimitManager", new ConnectionLimitManager());
    provideBean("authFailureLimiter", new AuthFailureLimiter());
    provideBean("connectionRegistry", {
        send: (connection: LocalConnection, payload: GatewayPayload): boolean => of(connection).sent.push(payload) > 0,
        close: (connection: LocalConnection, code: number, reason: string): void => {
            of(connection).closed = {code, reason};
            of(connection).open = false;
        },
        sendInvalidSession: (connection: LocalConnection, _resumable: boolean, message: string): void => {
            of(connection).invalidSessions.push(message);
        },
        isOpen: (connection: LocalConnection): boolean => of(connection).open,
        get: (connectionId: string): LocalConnection | undefined => connections.get(connectionId)?.connection,
        replaceSession: (connection: LocalConnection): void => {
            replaced.push(connection.connectionId);
        },
    });
    provideBean("connectionStore", {
        claimPending: async (): Promise<ClaimResult> => await claim(),
        releasePending: async (): Promise<void> => {
            released++;
        },
        heartbeat: async (): Promise<void> => undefined,
    });
    provideBean("sessionStore", {
        create: async (id: string, events: Set<string> | null): Promise<GatewaySessionData> => {
            onSessionCreated();
            return {sessionId, clientId: id, events: events ? [...events] : null, createdAt: 0, connectionId: "c1"};
        },
        getSequence: async (): Promise<number | null> => sequence,
        attach: async (): Promise<AttachedSession | null> => attached,
        destroy: async (_id: string, id: string): Promise<void> => {
            destroyed.push(id);
        },
        endConnection: async (ref: ConnectionRef, endSession: boolean): Promise<void> => {
            if (endSession && ref.sessionId) destroyed.push(ref.sessionId);
        },
        abandonResume: async (): Promise<void> => {
            abandoned++;
        },
    });
    provideBean("appAuthenticator", {
        getCredentials: async (): Promise<AppCredentialsResult> => {
            credentialRequests++;
            return credentials;
        },
    });
    provideBean("sessionDispatcher", {catchUp: (): void => undefined});
    provideBean("appBotUserService", {updateBotUser: async (): Promise<BotUserUpdate | null> => botUser});
    provideBean("appSetupService", {setupApplication: async (): Promise<App | null> => setupResult});
    provideBean("appStore", {getAuthorizedUsers: async (): Promise<string[]> => ["111", "222"]});
    handler = new GatewayHandler();
}

beforeEach((): void => {
    connections = new Map<string, TestConnection>();
    credentials = {status: "valid", credentials: {accessToken: "token-1", expiresAt: Date.now() + 3600000}};
    credentialRequests = 0;
    claim = async (): Promise<ClaimResult> => ({status: "claimed", pending});
    botUser = {botUserId: null, changed: false};
    setupResult = app;
    sequence = 3;
    attached = {buffer: [dispatch(1), dispatch(2), dispatch(3)], previousConnectionId: null};
    onSessionCreated = (): void => undefined;
    released = 0;
    destroyed = [];
    abandoned = 0;
    replaced = [];
    wire();
});

describe("GatewayHandler IDENTIFY", (): void => {
    test("valid credentials: READY with session, application and authorized users", async (): Promise<void> => {
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret", events: ["channel.cheer"]});

        expect(client.closed).toBeNull();
        expect(client.sent).toHaveLength(1);
        expect(client.sent[0].t).toBe("READY");
        expect(client.sent[0].d).toMatchObject({
            sessionId,
            application: {clientId, conduitId: "conduit-1", accessToken: "token-1"},
            authorizedUserIds: ["111", "222"],
            events: ["CHANNEL_CHEER"],
        });
        expect(client.connection.clientId).toBe(clientId);
        expect(client.connection.sessionId).toBe(sessionId);
    });

    test("wrong credentials close with 4004 and count as a failed attempt", async (): Promise<void> => {
        wire({GATEWAY_AUTH_FAILURE_LIMIT: "2"});
        credentials = {status: "invalid"};

        for (const id of ["c1", "c2"]) {
            const client: TestConnection = connect(id);
            await handler.identify(client.connection, {clientId, clientSecret: "wrong"});
            expect(client.closed).toEqual({code: GatewayCloseCode.AuthenticationFailed, reason: "Invalid clientId or clientSecret"});
        }

        // The address is blocked now: closed with 4007 before Twitch is asked again.
        const third: TestConnection = connect("c3");
        await handler.identify(third.connection, {clientId, clientSecret: "wrong"});
        expect(third.closed?.code).toBe(GatewayCloseCode.RateLimited);
        expect(credentialRequests).toBe(2);
    });

    test("a Twitch outage is INVALID_SESSION, not 4004 – and no failed attempt", async (): Promise<void> => {
        wire({GATEWAY_AUTH_FAILURE_LIMIT: "1"});
        credentials = {status: "unavailable"};

        for (const id of ["c1", "c2"]) {
            const client: TestConnection = connect(id);
            await handler.identify(client.connection, {clientId, clientSecret: "secret"});
            expect(client.closed).toBeNull();
            expect(client.invalidSessions).toEqual(["Twitch is unavailable, try again later"]);
        }
        expect(credentialRequests).toBe(2);
        expect(released).toBe(2);
    });

    test("unknown events close with 4010 before Twitch is asked", async (): Promise<void> => {
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret", events: ["channel.cheer", "channel.nope"]});

        expect(client.closed).toEqual({code: GatewayCloseCode.InvalidEvents, reason: "Unknown events: CHANNEL_NOPE"});
        expect(credentialRequests).toBe(0);
    });

    test("an unknown botUserId closes with 4004", async (): Promise<void> => {
        botUser = null;
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret", botUserId: "999"});

        expect(client.closed).toEqual({code: GatewayCloseCode.AuthenticationFailed, reason: "Invalid botUserId"});
    });

    test("a second IDENTIFY on the connection closes with 4005", async (): Promise<void> => {
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret"});
        await handler.identify(client.connection, {clientId, clientSecret: "secret"});

        expect(client.closed?.code).toBe(GatewayCloseCode.AlreadyAuthenticated);
    });

    test("IDENTIFY while another IDENTIFY runs closes with 4005, after the timeout with 4003", async (): Promise<void> => {
        claim = async (): Promise<ClaimResult> => ({status: "busy"});
        const busy: TestConnection = connect("c1");
        await handler.identify(busy.connection, {clientId, clientSecret: "secret"});
        expect(busy.closed?.code).toBe(GatewayCloseCode.AlreadyAuthenticated);

        claim = async (): Promise<ClaimResult> => ({status: "expired"});
        const late: TestConnection = connect("c2");
        await handler.identify(late.connection, {clientId, clientSecret: "secret"});
        expect(late.closed).toEqual({code: GatewayCloseCode.NotAuthenticated, reason: "You must IDENTIFY or RESUME within 30 seconds"});
        expect(credentialRequests).toBe(0);
    });

    test("the setup fails at Twitch: INVALID_SESSION, the connection may try again", async (): Promise<void> => {
        setupResult = null;
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret"});

        expect(client.closed).toBeNull();
        expect(client.invalidSessions).toEqual(["Could not set up EventSub for this application, try again later"]);
        expect(released).toBe(1);
    });

    test("the client leaves while the session is created: the session is discarded, nothing is sent", async (): Promise<void> => {
        const client: TestConnection = connect();
        onSessionCreated = (): void => {
            client.open = false;
        };
        await handler.identify(client.connection, {clientId, clientSecret: "secret"});

        expect(destroyed).toEqual([sessionId]);
        expect(client.sent).toEqual([]);
        expect(client.connection.clientId).toBeNull();
    });

    test("Redis failing: INVALID_SESSION instead of a closed connection", async (): Promise<void> => {
        claim = async (): Promise<ClaimResult> => {
            throw new Error("Redis down");
        };
        const client: TestConnection = connect();
        await handler.identify(client.connection, {clientId, clientSecret: "secret"});

        expect(client.closed).toBeNull();
        expect(client.invalidSessions).toEqual(["Service temporarily unavailable, try again later"]);
    });
});

describe("GatewayHandler RESUME", (): void => {
    test("replays the missed events, then RESUMED", async (): Promise<void> => {
        const client: TestConnection = connect();
        await handler.resume(client.connection, {clientId, clientSecret: "secret", sessionId, seq: 1});

        expect(client.sent.map((payload: GatewayPayload): string | null => payload.t)).toEqual(["CHANNEL_CHEER", "CHANNEL_CHEER", "RESUMED"]);
        expect(client.sent.map((payload: GatewayPayload): number | null => payload.s)).toEqual([2, 3, null]);
        // RESUMED carries the current app access token – a RESUME may have renewed it.
        expect(client.sent[2].d).toEqual({sessionId, replayed: 2, accessToken: "token-1"});
        expect(client.connection.sequence).toBe(3);
        expect(client.connection.sessionId).toBe(sessionId);
    });

    test("wrong credentials close with 4004", async (): Promise<void> => {
        credentials = {status: "invalid"};
        const client: TestConnection = connect();
        await handler.resume(client.connection, {clientId, clientSecret: "wrong", sessionId, seq: 1});

        expect(client.closed?.code).toBe(GatewayCloseCode.AuthenticationFailed);
    });

    test("a seq beyond the session closes with 4006 and destroys the session", async (): Promise<void> => {
        const client: TestConnection = connect();
        await handler.resume(client.connection, {clientId, clientSecret: "secret", sessionId, seq: 4});

        expect(client.closed).toEqual({code: GatewayCloseCode.InvalidSequence, reason: "Invalid sequence"});
        expect(destroyed).toEqual([sessionId]);
    });

    test("an unknown or expired session is INVALID_SESSION", async (): Promise<void> => {
        sequence = null;
        const client: TestConnection = connect();
        await handler.resume(client.connection, {clientId, clientSecret: "secret", sessionId, seq: 1});

        expect(client.closed).toBeNull();
        expect(client.invalidSessions).toEqual(["Session not found or expired, IDENTIFY again"]);
        expect(released).toBe(1);
    });

    test("a buffer that no longer reaches back to seq: INVALID_SESSION, IDENTIFY again", async (): Promise<void> => {
        attached = {buffer: [dispatch(3)], previousConnectionId: null};
        const client: TestConnection = connect();
        await handler.resume(client.connection, {clientId, clientSecret: "secret", sessionId, seq: 1});

        expect(client.invalidSessions).toEqual(["Too many missed events to resume, IDENTIFY again"]);
        expect(abandoned).toBe(1);
        expect(client.sent.some((payload: GatewayPayload): boolean => payload.op === GatewayOpCode.Dispatch)).toBe(false);
    });

    test("the connection that held the session until now is replaced", async (): Promise<void> => {
        connect("c0");
        attached = {buffer: [], previousConnectionId: "c0"};
        const client: TestConnection = connect("c1");
        await handler.resume(client.connection, {clientId, clientSecret: "secret", sessionId, seq: 3});

        expect(replaced).toEqual(["c0"]);
        expect(client.sent.at(-1)?.t).toBe("RESUMED");
    });
});
