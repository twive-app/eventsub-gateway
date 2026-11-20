import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import {OpCode} from "@gateway/GatewayBeanDecorators.ts";
import {
    GatewayCloseCode,
    GatewayDispatchEvent,
    gatewayHeartbeatSchema,
    gatewayIdentifySchema,
    GatewayOpCode,
    GatewayProtocol,
    gatewayResumeSchema,
    type GatewayIdentifyData,
    type GatewayPayload,
    type GatewayReadyData,
    type GatewayResumeData,
    type GatewayResumedData,
} from "@gateway/GatewayProtocol.ts";
import type {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import type {ConnectionRegistry, LocalConnection, SocketData} from "@gateway/connection/ConnectionRegistry.ts";
import type {ClaimResult, ConnectionStore, PendingConnection} from "@gateway/connection/ConnectionStore.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import {SessionStore, type AttachedSession, type GatewaySessionData} from "@gateway/session/SessionStore.ts";
import type {AppAuthenticator, AppCredentialsResult, ClientCredentials} from "@twitch/app/AppAuthenticator.ts";
import type {AppBotUserService, BotUserUpdate} from "@twitch/app/AppBotUserService.ts";
import type {AppSetupService} from "@twitch/app/AppSetupService.ts";
import type {AppAuthFailureLimiter} from "@twitch/app/AppAuthFailureLimiter.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";

/** Which authentication a metric or log line is about. */
type AuthenticationOp = "identify" | "resume";

/** Handles the client opcodes (@OpCode): HEARTBEAT, IDENTIFY (new session) and RESUME (continue a session). */
@Bean()
export class GatewayHandler {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    @Autowired()
    private connectionLimitManager!: ConnectionLimitManager;

    @Autowired()
    private appAuthFailureLimiter!: AppAuthFailureLimiter;

    @Autowired()
    private connectionRegistry!: ConnectionRegistry;

    @Autowired()
    private connectionStore!: ConnectionStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private appBotUserService!: AppBotUserService;

    @Autowired()
    private appSetupService!: AppSetupService;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    /** Answers with HEARTBEAT_ACK and keeps connection and session alive (timeout in memory, TTLs in Redis). */
    @OpCode(GatewayOpCode.Heartbeat, gatewayHeartbeatSchema)
    public heartbeat(connection: LocalConnection): void {
        this.connectionRegistry.send(connection, GatewayProtocol.heartbeatAckFrame);

        if (!connection.clientId || !connection.sessionId) return;
        connection.lastHeartbeatAt = Date.now();
        this.connectionStore.heartbeat(connection.clientId, connection.connectionId, connection.sessionId)
            .catch((error: unknown): void => this.logger.warnThrottled("CONNECTION", "Could not record a heartbeat", undefined, error));
    }

    /** IDENTIFY: checks the credentials, sets up the app (conduit, subscriptions) and creates a session → READY. */
    @OpCode(GatewayOpCode.Identify, gatewayIdentifySchema)
    public async identify(connection: LocalConnection, data: GatewayIdentifyData): Promise<void> {
        if (connection.clientId) return this.connectionRegistry.close(connection, GatewayCloseCode.AlreadyAuthenticated, "Already authenticated");
        if (this.closeIfAuthBlocked(connection)) return;

        let events: Set<string> | null = null;
        if (data.events) {
            events = new Set<string>(data.events.map(GatewayProtocol.toDispatchEventName));
            const invalid: string[] = [...events].filter((event: string): boolean => !GatewayProtocol.dispatchEventNames.has(event));

            if (invalid.length > 0) {
                return this.connectionRegistry.close(connection, GatewayCloseCode.InvalidEvents, `Unknown events: ${invalid.slice(0, 5).join(", ")}`);
            }
        }

        // subscriptionTypes: undefined keeps the stored ones, null allows every type, a list only these (as EventSub types).
        let subscriptionTypes: string[] | null | undefined = data.subscriptionTypes;
        if (data.subscriptionTypes) {
            const types: (string | null)[] = data.subscriptionTypes.map(GatewayProtocol.toSubscriptionType);
            const invalid: string[] = data.subscriptionTypes.filter((_name: string, index: number): boolean => types[index] === null);
            if (invalid.length > 0) {
                return this.connectionRegistry.close(connection, GatewayCloseCode.InvalidEvents, `Unknown subscription types: ${invalid.slice(0, 5).join(", ")}`);
            }
            subscriptionTypes = [...new Set<string>(types as string[])].sort();
        }

        await this.whileAuthenticating(connection, (): Promise<void> => this.runIdentify(connection, data, events, subscriptionTypes));
    }

    /** IDENTIFY after the checks: claim, credentials, bot, subscription types, setup, session, READY. */
    private async runIdentify(connection: LocalConnection, data: GatewayIdentifyData, events: Set<string> | null, subscriptionTypes: string[] | null | undefined): Promise<void> {
        // Claim the pending connection so a second IDENTIFY/RESUME on it can't run in parallel.
        const pending: PendingConnection | null = await this.claimPending(connection, data.clientId);
        if (!pending) return;

        try {
            const result: AppCredentialsResult = await this.appAuthenticator.getCredentials(data.clientId, data.clientSecret);
            if (!this.connectionRegistry.isOpen(connection)) return;
            if (result.status !== "valid") return await this.credentialsNotAccepted(connection, pending, result, "identify", data.clientId);

            const credentials: ClientCredentials = result.credentials;
            // The bot first, so the setup already restores the subscriptions with the right bot.
            const botUser: BotUserUpdate | null = await this.appBotUserService.updateBotUser(data.clientId, data.botUserId, credentials.accessToken);
            if (!botUser) {
                this.countAuthentication("identify", "invalid_bot");
                this.logger.warn("AUTH", "IDENTIFY rejected: unknown botUserId (4004)", {app: data.clientId, bot: data.botUserId, ip: connection.socket.data.remoteAddress});
                return this.authenticationFailed(connection, "Invalid botUserId");
            }

            const subscriptionTypesChanged: boolean = await this.appSetupService.updateSubscriptionTypes(data.clientId, subscriptionTypes);
            const app: App | null = await this.appSetupService.setupApplication(data.clientId, credentials, botUser, subscriptionTypesChanged);
            if (!this.connectionRegistry.isOpen(connection)) return;

            if (!app) {
                this.countAuthentication("identify", "setup_failed");
                await this.connectionStore.releasePending(pending);
                return this.connectionRegistry.sendInvalidSession(connection, false, "Could not set up EventSub for this application, try again later");
            }

            const authorizedUserIds: string[] = await this.appStore.getAuthorizedUsers(app.clientId);
            const session: GatewaySessionData = await this.sessionStore.create(app.clientId, events, pending);

            // The client left while the setup ran – drop the session right away.
            if (!this.connectionRegistry.isOpen(connection)) {
                await this.sessionStore.endConnection({connectionId: connection.connectionId, clientId: app.clientId, sessionId: session.sessionId}, true);
                return this.logger.debug("SESSION", "Client left during IDENTIFY, session discarded", {app: app.clientId, session: session.sessionId, conn: connection.connectionId});
            }

            this.connectionRegistry.send(connection, GatewayProtocol.createPayload<GatewayReadyData>(GatewayOpCode.Dispatch, {
                v: GatewayProtocol.version,
                sessionId: session.sessionId,
                application: {
                    clientId: app.clientId,
                    botUserId: app.botUserId,
                    conduitId: app.conduitId,
                    accessToken: credentials.accessToken,
                    subscriptionTypes: app.subscriptionTypes,
                },
                authorizedUserIds,
                events: session.events,
            }, GatewayDispatchEvent.Ready));

            this.authenticated(connection, app.clientId, session.sessionId, 0);

            this.countAuthentication("identify", "ok");
            this.logger.success("SESSION", "Identified", {id: session.sessionId, app: app.clientId, conn: connection.connectionId});
        } catch (error) {
            await this.handleAuthenticationError(connection, pending, error, data.clientId, "identify");
        }
    }

    /** RESUME: checks the credentials, attaches the session to this connection and replays the missed events. */
    @OpCode(GatewayOpCode.Resume, gatewayResumeSchema)
    public async resume(connection: LocalConnection, data: GatewayResumeData): Promise<void> {
        if (connection.clientId) return this.connectionRegistry.close(connection, GatewayCloseCode.AlreadyAuthenticated, "Already authenticated");
        if (this.closeIfAuthBlocked(connection)) return;

        await this.whileAuthenticating(connection, (): Promise<void> => this.runResume(connection, data));
    }

    /** RESUME after the checks: claim, credentials, attach, replay, RESUMED. */
    private async runResume(connection: LocalConnection, data: GatewayResumeData): Promise<void> {
        const pending: PendingConnection | null = await this.claimPending(connection, data.clientId);
        if (!pending) return;

        try {
            const result: AppCredentialsResult = await this.appAuthenticator.getCredentials(data.clientId, data.clientSecret);
            if (!this.connectionRegistry.isOpen(connection)) return;
            if (result.status !== "valid") return await this.credentialsNotAccepted(connection, pending, result, "resume", data.clientId);

            const sequence: number | null = await this.sessionStore.getSequence(data.clientId, data.sessionId);
            if (sequence === null) return await this.sessionNotFound(connection, pending);

            // The client claims events the session never sent – the session can't be trusted anymore.
            if (data.seq > sequence) {
                this.countAuthentication("resume", "invalid_sequence");
                await this.sessionStore.destroy(data.clientId, data.sessionId);
                return this.connectionRegistry.close(connection, GatewayCloseCode.InvalidSequence, "Invalid sequence");
            }

            const attached: AttachedSession | null = await this.sessionStore.attach(data.clientId, data.sessionId, pending);
            if (!attached) return await this.sessionNotFound(connection, pending);

            // null = the buffer no longer reaches back to seq.
            const replay: GatewayPayload[] | null = SessionStore.getReplay(attached.buffer, data.seq, sequence);
            if (!replay) {
                this.countAuthentication("resume", "replay_too_old");
                await this.sessionStore.abandonResume(data.clientId, data.sessionId, pending);
                return this.connectionRegistry.sendInvalidSession(connection, false, "Too many missed events to resume, IDENTIFY again");
            }

            if (!this.connectionRegistry.isOpen(connection)) {
                return await this.sessionStore.endConnection({connectionId: connection.connectionId, clientId: data.clientId, sessionId: data.sessionId}, false);
            }

            // The session may still be attached elsewhere: that connection is closed with 4011.
            this.replacePreviousConnection(attached.previousConnectionId, connection);

            for (const payload of replay) this.connectionRegistry.send(connection, payload);

            // The current app access token – RESUME may have renewed it (see AppTokenRenewalService).
            this.connectionRegistry.send(connection, GatewayProtocol.createPayload<GatewayResumedData>(GatewayOpCode.Dispatch, {
                sessionId: data.sessionId,
                replayed: replay.length,
                accessToken: result.credentials.accessToken,
            }, GatewayDispatchEvent.Resumed));

            this.authenticated(connection, data.clientId, data.sessionId, replay.at(-1)?.s ?? data.seq);

            this.countAuthentication("resume", "ok");
            this.logger.success("SESSION", "Resumed", {id: data.sessionId, app: data.clientId, conn: connection.connectionId, replayed: replay.length});
        } catch (error) {
            await this.handleAuthenticationError(connection, pending, error, data.clientId, "resume");
        }
    }

    /** Marks the connection as authenticating while the task runs – the identify timeout doesn't close it meanwhile. */
    private async whileAuthenticating(connection: LocalConnection, task: () => Promise<void>): Promise<void> {
        connection.authenticating = true;
        try {
            await task();
        } finally {
            connection.authenticating = false;
        }
    }

    /** Connections opened before the address hit the auth failure limit must not keep trying either. */
    private closeIfAuthBlocked(connection: LocalConnection): boolean {
        const rejection: SocketData["rejection"] = this.connectionLimitManager.getAuthRejection(connection.socket.data.remoteAddress);
        if (!rejection) return false;

        this.connectionRegistry.close(connection, rejection.code, rejection.reason);
        return true;
    }

    /** Wrong credentials close with 4004; a Twitch outage answers INVALID_SESSION instead. */
    private async credentialsNotAccepted(
        connection: LocalConnection,
        pending: PendingConnection,
        result: Exclude<AppCredentialsResult, {status: "valid"}>,
        attempt: AuthenticationOp,
        clientId: string,
    ): Promise<void> {
        this.countAuthentication(attempt, result.status === "invalid" ? "invalid_credentials" : "twitch_unavailable");
        if (result.status === "invalid") {
            this.logger.warn("AUTH", `${attempt.toUpperCase()} rejected: invalid client id or secret (4004)`, {app: clientId, ip: connection.socket.data.remoteAddress});
            return this.authenticationFailed(connection, "Invalid clientId or clientSecret");
        }

        // A Twitch outage says nothing about the credentials: no 4004, no failed attempt
        this.logger.warn("AUTH", `${attempt.toUpperCase()} postponed: Twitch unavailable`, {app: clientId});
        await this.connectionStore.releasePending(pending);
        this.connectionRegistry.sendInvalidSession(connection, false, "Twitch is unavailable, try again later");
    }

    /**
     * Sets the session on the connection after READY/RESUMED, then sends what was dispatched to the session meanwhile
     * (after the session existed in Redis or the replay was read, before it was set here).
     */
    private authenticated(connection: LocalConnection, clientId: string, sessionId: string, sequence: number): void {
        connection.clientId = clientId;
        connection.sessionId = sessionId;
        connection.sequence = sequence;
        connection.lastHeartbeatAt = Date.now();
        this.sessionDispatcher.catchUp(connection);
    }

    /** Closes with 4004 and counts the attempt for the auth failure limit of the address. */
    private authenticationFailed(connection: LocalConnection, reason: string): void {
        this.appAuthFailureLimiter.recordFailure(connection.socket.data.remoteAddress);
        this.connectionRegistry.close(connection, GatewayCloseCode.AuthenticationFailed, reason);
    }

    /** Closes the connection that held the session before this RESUME. */
    private replacePreviousConnection(previousConnectionId: string | null, connection: LocalConnection): void {
        if (!previousConnectionId || previousConnectionId === connection.connectionId) return;

        const previous: LocalConnection | undefined = this.connectionRegistry.get(previousConnectionId);
        if (previous) this.connectionRegistry.replaceSession(previous);
    }

    /** INVALID_SESSION for a session that doesn't exist (anymore). */
    private async sessionNotFound(connection: LocalConnection, pending: PendingConnection): Promise<void> {
        this.countAuthentication("resume", "session_not_found");
        await this.connectionStore.releasePending(pending);
        this.connectionRegistry.sendInvalidSession(connection, false, "Session not found or expired, IDENTIFY again");
    }

    /** Takes the pending entry of the connection; null if IDENTIFY/RESUME runs already or came too late. */
    private async claimPending(connection: LocalConnection, clientId: string): Promise<PendingConnection | null> {
        let claim: ClaimResult;
        try {
            claim = await this.connectionStore.claimPending(connection.connectionId);
        } catch (error) {
            this.logger.error("AUTH", "IDENTIFY/RESUME failed", {app: clientId, conn: connection.connectionId}, error);
            this.connectionRegistry.sendInvalidSession(connection, false, "Service temporarily unavailable, try again later");
            return null;
        }

        if (claim.status === "busy") {
            this.connectionRegistry.close(connection, GatewayCloseCode.AlreadyAuthenticated, "Already authenticated");
            return null;
        }

        if (claim.status === "expired") {
            const seconds: number = this.configManager.get().gateway.identifyTimeout / 1000;
            this.connectionRegistry.close(connection, GatewayCloseCode.NotAuthenticated, `You must IDENTIFY or RESUME within ${seconds} seconds`);
            return null;
        }

        return claim.pending;
    }

    /** Counts an IDENTIFY or RESUME by its outcome. */
    private countAuthentication(op: AuthenticationOp, result: string): void {
        this.metricsRegistry.increment("authentications", "IDENTIFY and RESUME by outcome", {op, result});
    }

    /** Redis failed during IDENTIFY/RESUME: INVALID_SESSION, the client may try again later. */
    private async handleAuthenticationError(connection: LocalConnection, pending: PendingConnection, error: unknown, clientId: string, op: AuthenticationOp): Promise<void> {
        this.countAuthentication(op, "error");
        this.logger.error("AUTH", "IDENTIFY/RESUME failed", {app: clientId, conn: connection.connectionId}, error);

        if (!this.connectionRegistry.isOpen(connection)) return;

        try {
            await this.connectionStore.releasePending(pending);
        } catch {
            // The pending entry expires on its own.
        }

        this.connectionRegistry.sendInvalidSession(connection, false, "Service temporarily unavailable, try again later");
    }
}
