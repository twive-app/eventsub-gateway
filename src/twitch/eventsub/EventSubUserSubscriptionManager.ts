import type {
    EventSubSubscription,
    RESTGetAuthorizationByUserResponse,
    RESTPostEventSubSubscriptionRequestBody,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {GatewayDispatchEvent, GatewayProtocol} from "@gateway/GatewayProtocol.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {App, AppStore, PublicSubscription} from "@twitch/app/AppStore.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";
import type {EventSubSubscriptionManager, SubscribeOutcome} from "@twitch/eventsub/EventSubSubscriptionManager.ts";

// Twitch's maximum of user ids per Get Authorization By User request.
const authorizationBatchSize: number = 10;

// How long a revoke is remembered – longer than any restore that read the user's scopes before it.
const revocationMemoryMs: number = 60 * 60 * 1000;

/** Data of USER_SUBSCRIBED: a user's subscriptions are set up – which events now arrive for it, which failed. */
export interface UserSubscribed {
    userId: string;
    // grant: the user authorized the app; resync: subscriptions Twitch revoked were created again.
    reason: "grant" | "resync";
    // Dispatch names of every event subscribed for the user's channel, already existing ones included.
    events: string[];
    // Dispatch names that couldn't be created – each one came as SUBSCRIPTION_FAILED before.
    failed: string[];
}

/** What subscribing one user found and did. */
interface UserSubscribeOutcome extends SubscribeOutcome {
    // The user's subscriptions that were on the conduit before.
    existing: EventSubSubscription[];
}

/** What a restore of the users found – EventSubPublicSubscriptionManager restores the public subscriptions from it. */
export interface RestoredUsers {
    // All active subscriptions of the app, null if Twitch couldn't list them.
    existingSubs: EventSubSubscription[] | null;
    // The subscriptions on orphaned conduits that were taken over.
    adoptedSubs: EventSubSubscription[];
    // Users of those subscriptions Twitch says don't authorize the app.
    unauthorized: Set<string>;
    // The public subscriptions the app requested.
    publicSubs: PublicSubscription[];
}

/**
 * The subscriptions of the users who authorized the app: grant, revoke, resync and restore – one user's work strictly in
 * order – and moving the bot chat subscriptions to the current bot.
 */
@Bean()
export class EventSubUserSubscriptionManager {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private eventSubSubscriptionManager!: EventSubSubscriptionManager;

    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    @Autowired()
    private logger!: Logger;

    // One reconcile per app at a time; a change during a run queues exactly one more run.
    private readonly reconcileRuns: Map<string, Promise<void>> = new Map<string, Promise<void>>();
    private readonly reconcileQueue: Map<string, string> = new Map<string, string>();
    // clientId:userId → tail of that user's grant, revoke and restore work, so none of them overtakes another.
    private readonly userTasks: Map<string, Promise<void>> = new Map<string, Promise<void>>();
    // clientId:userId → when its revoke was processed, oldest first – a restore that read the scopes before skips it.
    private readonly revokedAt: Map<string, number> = new Map<string, number>();
    // clientId:userId with a resync queued but not started – the revocations of one user's subscriptions share it.
    private readonly queuedResyncs: Set<string> = new Set<string>();

    /** A user authorized the app (user.authorization.grant): subscribe to everything the granted scopes allow. */
    public userGranted(clientId: string, userId: string): Promise<void> {
        return this.runForUser(clientId, userId, "grant", (): Promise<void> => this.grantUser(clientId, userId));
    }

    /** A user revoked the app (user.authorization.revoke) – Twitch deletes the subscriptions itself. */
    public userRevoked(clientId: string, userId: string): Promise<void> {
        return this.runForUser(clientId, userId, "revoke", (): Promise<void> => this.forgetUser(clientId, userId));
    }

    /** The account of a user no longer exists (status user_removed): forget it like a revoke. */
    public userRemoved(clientId: string, userId: string): Promise<void> {
        return this.runForUser(clientId, userId, "removal", async (): Promise<void> => {
            await this.forgetUser(clientId, userId);
            this.logger.info("EVENTSUB", "User no longer exists, forgotten", {app: clientId, user: userId});
        });
    }

    /**
     * Twitch revoked subscriptions of a user, although it may still authorize the app (a password change, a beta type
     * back from maintenance): asks Twitch for its scopes and creates what is missing – nothing if it really revoked.
     * Queued behind the user's grant/revoke work, once for all revocations that arrive meanwhile.
     */
    public resyncUser(clientId: string, userId: string): void {
        const key: string = `${clientId}:${userId}`;
        if (this.queuedResyncs.has(key)) return;
        this.queuedResyncs.add(key);

        void this.runForUser(clientId, userId, "resync", async (): Promise<void> => {
            this.queuedResyncs.delete(key);
            const app: App | null = await this.appStore.find(clientId);
            const accessToken: string | null = app?.conduitId ? await this.appAuthenticator.getAppAccessToken(clientId) : null;
            if (!app || !accessToken) return;

            const outcome: UserSubscribeOutcome | null = await this.syncUserSubscriptions(app, accessToken, userId);
            if (!outcome) return;

            if (outcome.failed.length === 0) this.logger.info("EVENTSUB", "Revoked subscriptions of a user created again", {app: clientId, user: userId});
            this.dispatchUserSubscribed(clientId, userId, "resync", outcome);
        });
    }

    /**
     * Syncs every known user. Known are the stored users plus those found on the conduit (e.g. after Redis lost them)
     * and on `adoptFrom` – leftover conduits of ours, after a Redis loss the only place that still knows the users.
     * The result lets EventSubPublicSubscriptionManager restore and take over the public subscriptions.
     */
    public async restoreUserSubscriptions(app: App, accessToken: string, adoptFrom: string[] = []): Promise<RestoredUsers> {
        const userIds: Set<string> = new Set<string>(await this.appStore.getAuthorizedUsers(app.clientId));

        const existingSubs: EventSubSubscription[] | null = await this.eventSubSubscriptionManager.getSubscriptions(accessToken, app.clientId);
        const publicSubs: PublicSubscription[] = await this.appStore.getPublicSubscriptions(app.clientId);
        const publicKeys: Set<string> = new Set<string>(publicSubs.map((sub: PublicSubscription): string => EventSubSubscriptionHelper.subscriptionKey(sub)));
        const adoptedSubs: EventSubSubscription[] = (existingSubs ?? []).filter((sub: EventSubSubscription): boolean => (
            adoptFrom.some((conduitId: string): boolean => EventSubSubscriptionHelper.isOnConduit(sub, conduitId))
        ));
        const restored: RestoredUsers = {existingSubs, adoptedSubs, unauthorized: new Set<string>(), publicSubs};

        for (const sub of existingSubs ?? []) {
            if (!EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId) && !adoptedSubs.includes(sub)) continue;
            // A public subscription doesn't mean its user authorized the app.
            if (publicKeys.has(EventSubSubscriptionHelper.subscriptionKey(sub))) continue;

            const userId: string | null = EventSubSubscriptionHelper.getConditionUserId(sub);
            if (userId) userIds.add(userId);
        }

        if (adoptedSubs.length > 0) this.logger.info("EVENTSUB", "Taking over the subscriptions of an orphaned conduit", {app: app.clientId, conduits: adoptFrom, count: adoptedSubs.length});
        if (userIds.size === 0) return restored;

        this.logger.info("EVENTSUB", "Restoring user subscriptions", {app: app.clientId, users: userIds.size});
        // One subscription list for all users and the scopes of 10 users per request, not two requests per user.
        // If the list failed, every user asks for its own subscriptions.
        const ids: string[] = [...userIds];
        for (let start: number = 0; start < ids.length; start += authorizationBatchSize) {
            const batch: string[] = ids.slice(start, start + authorizationBatchSize);
            const readAt: number = Date.now();
            const authorizations: Map<string, string[]> | null = await this.getAuthorizations(app, accessToken, batch);
            if (!authorizations) continue;

            for (const userId of batch) {
                // Missing = the user no longer authorizes the app – nothing to restore.
                const scopes: string[] | undefined = authorizations.get(userId);
                if (!scopes) {
                    restored.unauthorized.add(userId);
                    continue;
                }

                // In the user's queue: a grant or revoke running now finishes first, one arriving later waits.
                await this.runForUser(app.clientId, userId, "restore", async (): Promise<void> => {
                    // Revoked after the scopes were read – they are stale.
                    if ((this.revokedAt.get(`${app.clientId}:${userId}`) ?? 0) >= readAt) return;
                    await this.subscribeUser(app, accessToken, userId, scopes, existingSubs);
                });
            }
        }
        return restored;
    }

    /**
     * After the bot or the subscription types changed: deletes what no longer fits, then creates what is missing – runs
     * once per app at a time, changes meanwhile are queued; never rejects.
     */
    public reconcileSubscriptions(clientId: string, accessToken: string): Promise<void> {
        const running: Promise<void> | undefined = this.reconcileRuns.get(clientId);
        if (running) {
            this.reconcileQueue.set(clientId, accessToken);
            return running;
        }

        const run: Promise<void> = this.runReconcile(clientId, accessToken).finally((): void => {
            this.reconcileRuns.delete(clientId);
        });
        this.reconcileRuns.set(clientId, run);
        return run;
    }

    /** Runs the work of one user (grant, revoke, restore) strictly in arrival order; different users run in parallel. */
    private runForUser(clientId: string, userId: string, kind: string, task: () => Promise<void>): Promise<void> {
        const key: string = `${clientId}:${userId}`;
        const next: Promise<void> = (this.userTasks.get(key) ?? Promise.resolve()).then(task).catch((error: unknown): void => {
            this.logger.error("EVENTSUB", `Could not process the authorization ${kind}`, {app: clientId, user: userId}, error);
        });

        this.userTasks.set(key, next);
        next.then((): void => {
            if (this.userTasks.get(key) === next) this.userTasks.delete(key);
        });
        return next;
    }

    /** A user revoked the app: forget it, and remember the revoke for restores that read its scopes before. */
    private async forgetUser(clientId: string, userId: string): Promise<void> {
        const now: number = Date.now();
        for (const [key, at] of this.revokedAt) {
            if (now - at < revocationMemoryMs) break;
            this.revokedAt.delete(key);
        }
        const key: string = `${clientId}:${userId}`;
        this.revokedAt.delete(key);
        this.revokedAt.set(key, now);

        await this.appStore.removeAuthorizedUser(clientId, userId);
    }

    /** The grant itself: the scopes of the user, then a reconcile if the bot or the subscription types changed meanwhile. */
    private async grantUser(clientId: string, userId: string): Promise<void> {
        let app: App | null;
        try {
            app = await this.appStore.find(clientId);
        } catch (error) {
            this.logger.warn("EVENTSUB", "Authorization grant not processed: app could not be loaded", {app: clientId, user: userId}, error);
            return;
        }

        if (!app) {
            this.logger.warn("EVENTSUB", "Authorization grant for an unknown app", {app: clientId, user: userId});
            return;
        }

        const accessToken: string | null = await this.appAuthenticator.getAppAccessToken(clientId);
        if (!accessToken) return;

        const outcome: UserSubscribeOutcome | null = await this.syncUserSubscriptions(app, accessToken, userId);
        if (outcome) this.dispatchUserSubscribed(clientId, userId, "grant", outcome);

        // Not awaited: the reconcile restores every user – including this one, whose queue this grant still holds.
        const current: App | null = await this.appStore.find(clientId);
        const changed: boolean = current !== null && (current.botUserId !== app.botUserId || JSON.stringify(current.subscriptionTypes) !== JSON.stringify(app.subscriptionTypes));
        if (changed) void this.reconcileSubscriptions(clientId, accessToken);
    }

    /** Subscribes a user to everything the granted scopes allow that isn't on the conduit yet; null if that couldn't be checked. */
    private async syncUserSubscriptions(app: App, accessToken: string, userId: string): Promise<UserSubscribeOutcome | null> {
        if (!app.conduitId) return null;

        const authorizations: Map<string, string[]> | null = await this.getAuthorizations(app, accessToken, [userId]);
        const scopes: string[] | undefined = authorizations?.get(userId);
        if (!scopes) return null;

        return await this.subscribeUser(app, accessToken, userId, scopes, null);
    }

    /** Scopes per user (up to 10 per request); users without an authorization are missing, null if Twitch failed. */
    private async getAuthorizations(app: App, accessToken: string, userIds: string[]): Promise<Map<string, string[]> | null> {
        let response: RESTGetAuthorizationByUserResponse;
        try {
            response = await this.twitchClient.getAuthorizations(userIds, {accessToken, clientId: app.clientId});
        } catch (error) {
            this.logger.error("EVENTSUB", "Could not get the granted scopes", {app: app.clientId, users: userIds}, error);
            return null;
        }

        return new Map<string, string[]>(response.data.map((authorization: RESTGetAuthorizationByUserResponse["data"][number]): [string, string[]] => [
            authorization.user_id,
            authorization.scopes,
        ]));
    }

    /**
     * Creates what the scopes allow and isn't on the conduit yet. `knownSubs` (all active subscriptions of the app, e.g.
     * from a restore) saves the request for the user's subscriptions; null asks Twitch.
     */
    private async subscribeUser(app: App, accessToken: string, userId: string, scopes: string[], knownSubs: EventSubSubscription[] | null): Promise<UserSubscribeOutcome | null> {
        if (!app.conduitId) return null;

        // user_id matches every condition field, so this also finds the bot chat subscriptions of the channel.
        const userSubs: EventSubSubscription[] | null = knownSubs
            ? knownSubs.filter((sub: EventSubSubscription): boolean => this.hasConditionUser(sub, userId))
            : await this.eventSubSubscriptionManager.getSubscriptions(accessToken, app.clientId, {user_id: userId});
        if (!userSubs) return null;

        const existingSubs: EventSubSubscription[] = userSubs.filter((sub: EventSubSubscription): boolean => EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId));
        // Only the types the app wants (subscriptionTypes of IDENTIFY).
        const subs: RESTPostEventSubSubscriptionRequestBody[] = this.eventSubScopeService.forUser(
            scopes,
            app.botUserId,
            userId,
            EventSubSubscriptionHelper.conduitTransport(app.conduitId),
            existingSubs,
        ).filter((sub: RESTPostEventSubSubscriptionRequestBody): boolean => EventSubSubscriptionHelper.isWantedType(app.subscriptionTypes, sub.type));

        await this.addAuthorizedUsers(app.clientId, userId);
        return {existing: existingSubs, ...await this.eventSubSubscriptionManager.createSubscriptions(subs, accessToken, app.clientId)};
    }

    /** USER_SUBSCRIBED: the events of the user's own channel – not those of other channels it is the bot in. */
    private dispatchUserSubscribed(clientId: string, userId: string, reason: UserSubscribed["reason"], outcome: UserSubscribeOutcome): void {
        const eventsOf: (subs: {type: string; condition: object}[]) => string[] = (subs: {type: string; condition: object}[]): string[] => [...new Set<string>(subs
            .filter((sub: {type: string; condition: object}): boolean => EventSubSubscriptionHelper.getConditionUserId(sub) === userId)
            .map((sub: {type: string}): string => GatewayProtocol.toDispatchEventName(sub.type)))].sort();

        const data: UserSubscribed = {userId, reason, events: eventsOf([...outcome.existing, ...outcome.subscribed]), failed: eventsOf(outcome.failed)};
        this.sessionDispatcher.dispatch(clientId, GatewayDispatchEvent.UserSubscribed, data);
    }

    /** Repeats the reconcile until no change is queued anymore. */
    private async runReconcile(clientId: string, accessToken: string): Promise<void> {
        let next: string | undefined = accessToken;
        while (next !== undefined) {
            this.reconcileQueue.delete(clientId);
            try {
                await this.reconcileOnce(clientId, next);
            } catch (error) {
                this.logger.error("EVENTSUB", "Could not reconcile the subscriptions", {app: clientId}, error);
            }
            next = this.reconcileQueue.get(clientId);
        }
    }

    /**
     * Deletes the user subscriptions that no longer fit – bot chat subscriptions of another bot, types the app no longer
     * wants (requested public ones stay) – then creates the missing ones.
     */
    private async reconcileOnce(clientId: string, accessToken: string): Promise<void> {
        // Read fresh: the bot or the types may have changed again since the run was queued.
        const app: App | null = await this.appStore.find(clientId);
        if (!app?.conduitId) return;

        this.logger.info("EVENTSUB", "Reconciling the subscriptions", {app: clientId, bot: app.botUserId ?? "none", types: app.subscriptionTypes?.length ?? "all"});

        const subs: EventSubSubscription[] | null = await this.eventSubSubscriptionManager.getSubscriptions(accessToken, clientId);
        if (!subs) return;
        const publicKeys: Set<string> = new Set<string>((await this.appStore.getPublicSubscriptions(clientId))
            .map((sub: PublicSubscription): string => EventSubSubscriptionHelper.subscriptionKey(sub)));

        let removed: number = 0;
        for (const sub of subs) {
            if (!EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId) || publicKeys.has(EventSubSubscriptionHelper.subscriptionKey(sub))) continue;

            const botUserId: string | null = this.eventSubScopeService.getBotUserId(sub);
            const otherBot: boolean = botUserId !== null && botUserId !== app.botUserId;
            // The authorization subscriptions have no user – they always stay.
            const unwanted: boolean = EventSubSubscriptionHelper.getConditionUserId(sub) !== null && !EventSubSubscriptionHelper.isWantedType(app.subscriptionTypes, sub.type);
            if ((otherBot || unwanted) && await this.eventSubSubscriptionManager.unsubscribe(sub, accessToken, clientId)) removed++;
        }
        if (removed > 0) this.logger.success("EVENTSUB", "Subscriptions that no longer fit removed", {app: clientId, count: removed});

        await this.restoreUserSubscriptions(app, accessToken);
    }

    /** Stores authorized users; a Redis failure is only logged (the conduit still knows them). */
    private async addAuthorizedUsers(clientId: string, ...userIds: string[]): Promise<void> {
        try {
            await this.appStore.addAuthorizedUsers(clientId, ...userIds);
        } catch (error) {
            this.logger.warn("EVENTSUB", "Could not store the authorized users", {app: clientId, users: userIds}, error);
        }
    }

    /** Whether a user id is in any condition field – what Twitch's user_id filter matches. */
    private hasConditionUser(sub: EventSubSubscription, userId: string): boolean {
        return Object.values(sub.condition as Record<string, unknown>).includes(userId);
    }
}
