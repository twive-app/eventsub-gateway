import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test";
import {ProxyService} from "@core/proxy/ProxyService.ts";
import {RedisKeys} from "@core/redis/RedisKeys.ts";
import {GatewayHandler} from "@gateway/GatewayHandler.ts";
import {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import {AppAuthFailureLimiter} from "@twitch/app/AppAuthFailureLimiter.ts";
import {ConnectionRegistry, type LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import {ConnectionStore, type ClaimResult} from "@gateway/connection/ConnectionStore.ts";
import {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import {SessionStore, type GatewaySessionData} from "@gateway/session/SessionStore.ts";
import type {AppCredentialsResult} from "@twitch/app/AppAuthenticator.ts";
import type {BotUserUpdate} from "@twitch/app/AppBotUserService.ts";
import type {App} from "@twitch/app/AppStore.ts";
import {provideBean} from "../../helpers.ts";
import {WebSocketMockup} from "../../mockups/WebSocketMockup.ts";
import {TestRedis} from "../TestRedis.ts";

const app: App = {clientId: "abc", botUserId: null, subscriptionTypes: null, conduitId: "conduit-1", hasAuthorizationSubscriptions: true, lastActiveAt: 0, createdAt: 0, updatedAt: 0};

/**
 * IDENTIFY and RESUME with everything of the gateway that lives in Redis or in memory – stores, registry, dispatcher –
 * real; only the Twitch side (credentials, app setup) is a stand-in. Covers what happens *while* they run.
 */
describe.skipIf(!TestRedis.available)("GatewayHandler against Redis", (): void => {
    let redis: TestRedis;
    let connections: ConnectionStore;
    let sessions: SessionStore;
    let registry: ConnectionRegistry;
    let dispatcher: SessionDispatcher;
    let handler: GatewayHandler;
    // Resolves the app setup – until then IDENTIFY hangs in it, like a large app being set up at Twitch.
    let setupDone: () => void;
    let setupBlocked: Promise<void>;

    /** A new connection: registered locally, pending in Redis. */
    async function connect(connectionId: string): Promise<{socket: WebSocketMockup; connection: LocalConnection}> {
        const socket: WebSocketMockup = new WebSocketMockup(connectionId);
        const connection: LocalConnection = registry.add(socket.asSocket());
        await connections.createPending(connectionId, socket.data.remoteAddress);
        return {socket, connection};
    }

    /** A session whose connection went away – waiting for RESUME. */
    async function detachedSession(): Promise<GatewaySessionData> {
        await connections.createPending("old", "203.0.113.5");
        const claim: ClaimResult = await connections.claimPending("old");
        if (claim.status !== "claimed") throw new Error("not claimed");
        const session: GatewaySessionData = await sessions.create(app.clientId, null, claim.pending);
        await sessions.detach(app.clientId, session.sessionId, "old");
        return session;
    }

    /** Lets an event arrive from Twitch right after `method` of the SessionStore ran – inside IDENTIFY/RESUME. */
    function dispatchAfter(method: "create" | "attach"): void {
        const target: Record<string, (...args: unknown[]) => Promise<unknown>> = sessions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const original: (...args: unknown[]) => Promise<unknown> = target[method].bind(sessions);
        target[method] = async (...args: unknown[]): Promise<unknown> => {
            const result: unknown = await original(...args);
            dispatcher.dispatch(app.clientId, "CHANNEL_CHEER", {bits: 100});
            await Bun.sleep(20);
            return result;
        };
    }

    /** Lets the background deliveries finish. */
    async function settle(): Promise<void> {
        await Bun.sleep(40);
    }

    beforeAll(async (): Promise<void> => {
        redis = await TestRedis.connect();
    });

    beforeEach((): void => {
        redis.reset();
        setupBlocked = Promise.resolve();
        setupDone = (): void => undefined;

        provideBean("proxyService", new ProxyService());
        provideBean("connectionLimitManager", new ConnectionLimitManager());
        provideBean("appAuthFailureLimiter", new AppAuthFailureLimiter());
        provideBean("appStore", {getClientIds: async (): Promise<string[]> => [], getAuthorizedUsers: async (): Promise<string[]> => []});
        provideBean("appAuthenticator", {
            getCredentials: async (): Promise<AppCredentialsResult> => ({status: "valid", credentials: {accessToken: "token", expiresAt: Date.now() + 3600000}}),
        });
        provideBean("appBotUserService", {updateBotUser: async (): Promise<BotUserUpdate> => ({botUserId: null, changed: false})});
        provideBean("appSetupService", {
            updateSubscriptionTypes: async (): Promise<boolean> => false,
            setupApplication: async (): Promise<App> => {
                await setupBlocked;
                return app;
            },
        });
        connections = new ConnectionStore();
        provideBean("connectionStore", connections);
        sessions = new SessionStore();
        provideBean("sessionStore", sessions);
        registry = new ConnectionRegistry();
        provideBean("connectionRegistry", registry);
        dispatcher = new SessionDispatcher();
        provideBean("sessionDispatcher", dispatcher);
        handler = new GatewayHandler();
    });

    afterEach(async (): Promise<void> => {
        await redis.clear();
    });

    afterAll(async (): Promise<void> => {
        await redis.close();
    });

    test("an IDENTIFY that takes longer than the identify timeout isn't closed while it runs", async (): Promise<void> => {
        setupBlocked = new Promise<void>((resolve: () => void): void => {
            setupDone = resolve;
        });
        const {socket, connection}: {socket: WebSocketMockup; connection: LocalConnection} = await connect("c1");
        const identify: Promise<void> = handler.identify(connection, {clientId: app.clientId, clientSecret: "secret"});
        await Bun.sleep(10);

        // The setup still runs when the identify timeout is over.
        await redis.raw.send("PEXPIRE", [RedisKeys.gateway.pendingConnection("c1"), "1"]);
        await Bun.sleep(5);
        await registry.checkTimeouts();
        expect(socket.closed).toBeNull();

        setupDone();
        await identify;
        expect(socket.summary()).toEqual(["READY#-"]);
    });

    test("a connection that never sent IDENTIFY is still closed after the timeout", async (): Promise<void> => {
        const {socket}: {socket: WebSocketMockup} = await connect("c1");
        await redis.raw.send("PEXPIRE", [RedisKeys.gateway.pendingConnection("c1"), "1"]);
        await Bun.sleep(5);

        await registry.checkTimeouts();
        expect(socket.closed?.code).toBe(4003);
    });

    test("an event dispatched while IDENTIFY creates the session arrives right after READY", async (): Promise<void> => {
        dispatchAfter("create");
        const {socket, connection}: {socket: WebSocketMockup; connection: LocalConnection} = await connect("c1");
        await handler.identify(connection, {clientId: app.clientId, clientSecret: "secret"});
        await settle();

        expect(socket.summary()).toEqual(["READY#-", "CHANNEL_CHEER#1"]);
    });

    test("an event dispatched while RESUME attaches the session arrives right after RESUMED – once", async (): Promise<void> => {
        const session: GatewaySessionData = await detachedSession();
        dispatcher.dispatch(app.clientId, "CHANNEL_FOLLOW", {});
        await settle();

        dispatchAfter("attach");
        const {socket, connection}: {socket: WebSocketMockup; connection: LocalConnection} = await connect("c1");
        await handler.resume(connection, {clientId: app.clientId, clientSecret: "secret", sessionId: session.sessionId, seq: 0});
        await settle();
        // 1 from the replay, 2 caught up after RESUMED – without waiting for another event.
        expect(socket.summary()).toEqual(["CHANNEL_FOLLOW#1", "RESUMED#-", "CHANNEL_CHEER#2"]);

        dispatcher.dispatch(app.clientId, "CHANNEL_FOLLOW", {});
        await settle();
        expect(socket.summary()).toEqual(["CHANNEL_FOLLOW#1", "RESUMED#-", "CHANNEL_CHEER#2", "CHANNEL_FOLLOW#3"]);
    });
});
