import {
    EventSubSubscriptionType,
    type EventSubWebhookNotificationRequestBody,
    type EventSubWebhookRevokeSubscriptionRequestBody,
    type UserAuthorizationGrantEvent,
    type UserAuthorizationRevokeEvent,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import {GatewayDispatchEvent, GatewayProtocol} from "@gateway/GatewayProtocol.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {EventSubSubscriptionManager} from "@twitch/eventsub/EventSubSubscriptionManager.ts";

/** Transport of a delivered message – `twitch-dev-types` only knows the webhook variant. */
interface EventSubDeliveryTransport {
    method?: string;
    conduit_id?: string;
}

/** The subscription part of a delivered message that the handler needs. */
interface EventSubDeliveredSubscription {
    type: string;
    transport?: EventSubDeliveryTransport;
}

/** Handles verified EventSub messages: forwards events to the sessions and keeps the authorized users in sync. */
@Bean()
export class EventSubMessageHandler {
    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private eventSubSubscriptionManager!: EventSubSubscriptionManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    // clientId:userId → tail of that user's grant/revoke work, so a revoke can't overtake a grant.
    private readonly userTasks: Map<string, Promise<void>> = new Map<string, Promise<void>>();

    /** A notification: dispatch it to every session of the app, then the grant/revoke bookkeeping. */
    public async handleNotification(clientId: string, notification: EventSubWebhookNotificationRequestBody): Promise<void> {
        if (!await this.isFromCurrentConduit(clientId, notification.subscription as EventSubDeliveredSubscription)) return;

        // Forward first – the bookkeeping (Helix calls for a grant) must not delay the event.
        this.sessionDispatcher.dispatch(clientId, GatewayProtocol.toDispatchEventName(notification.subscription.type), notification.event);

        switch (notification.subscription.type) {
            case EventSubSubscriptionType.UserAuthorizationGrant: {
                const event: UserAuthorizationGrantEvent = notification.event as UserAuthorizationGrantEvent;
                await this.runForUser(clientId, event.user_id, "grant", (): Promise<void> => this.userAuthorizationGrantEvent(clientId, event));
                break;
            }

            case EventSubSubscriptionType.UserAuthorizationRevoke: {
                const event: UserAuthorizationRevokeEvent = notification.event as UserAuthorizationRevokeEvent;
                await this.runForUser(clientId, event.user_id, "revoke", (): Promise<void> => this.userAuthorizationRevokeEvent(clientId, event));
                break;
            }
        }
    }

    /** Runs the grant/revoke work of one user strictly in arrival order; different users run in parallel. */
    private runForUser(clientId: string, userId: string, kind: string, task: () => Promise<void>): Promise<void> {
        const key: string = `${clientId}:${userId}`;
        const next: Promise<void> = (this.userTasks.get(key) ?? Promise.resolve()).then(task).catch((error: unknown): void => {
            this.logger.error("EVENTSUB", `Failed processing the authorization ${kind} of user ${userId} for application ${clientId}`);
            this.errorReporter.handle(error, {clientId, userId});
        });

        this.userTasks.set(key, next);
        next.then((): void => {
            if (this.userTasks.get(key) === next) this.userTasks.delete(key);
        });
        return next;
    }

    /** A revoked subscription: tell the sessions; a revoked authorization subscription is renewed later. */
    public async handleRevocation(clientId: string, revocation: EventSubWebhookRevokeSubscriptionRequestBody): Promise<void> {
        const {subscription}: EventSubWebhookRevokeSubscriptionRequestBody = revocation;
        if (!await this.isFromCurrentConduit(clientId, subscription as EventSubDeliveredSubscription)) return;

        this.sessionDispatcher.dispatch(clientId, GatewayDispatchEvent.SubscriptionRevoked, {
            id: subscription.id,
            type: subscription.type,
            version: subscription.version,
            status: subscription.status,
            condition: subscription.condition,
        });

        // Without these two subscriptions no new users arrive – the next IDENTIFY subscribes again.
        if (subscription.type === EventSubSubscriptionType.UserAuthorizationGrant ||
            subscription.type === EventSubSubscriptionType.UserAuthorizationRevoke
        ) {
            try {
                await this.appStore.update(clientId, {hasAuthorizationSubscriptions: false});
            } catch (error) {
                this.logger.warning("EVENTSUB", `Could not mark the app subscriptions of application ${clientId} as revoked`);
                this.errorReporter.handle(error, {clientId});
            }
        }
    }

    /** A user authorized the app: subscribe to everything the granted scopes allow. */
    private async userAuthorizationGrantEvent(clientId: string, event: UserAuthorizationGrantEvent): Promise<void> {
        let app: App | null;
        try {
            app = await this.appStore.find(clientId);
        } catch (error) {
            this.logger.warning("EVENTSUB", `Could not load application ${clientId}, authorization grant of user ${event.user_id} not processed`);
            this.errorReporter.handle(error, {clientId, userId: event.user_id});
            return;
        }

        if (!app) {
            this.logger.warning("EVENTSUB", `Authorization grant for unknown application ${clientId}`);
            return;
        }

        const accessToken: string | null = await this.appAuthenticator.getAppAccessToken(clientId);
        if (!accessToken) return;

        await this.eventSubSubscriptionManager.syncUserSubscriptions(app, accessToken, event.user_id);

        const current: App | null = await this.appStore.find(clientId);
        if (current && current.botUserId !== app.botUserId) await this.eventSubSubscriptionManager.reconcileBotSubscriptions(clientId, accessToken);
    }

    /** False for messages of another (orphaned) conduit of ours – they would reach every session twice. */
    private async isFromCurrentConduit(clientId: string, subscription: EventSubDeliveredSubscription): Promise<boolean> {
        const transport: EventSubDeliveryTransport | undefined = subscription.transport;
        if (transport?.method !== "conduit" || !transport.conduit_id) return true;

        let conduitId: string | null;
        try {
            // The cached id answers the usual case; only a mismatch is checked against Redis.
            conduitId = await this.appStore.getConduitId(clientId);
            if (conduitId && conduitId !== transport.conduit_id) conduitId = await this.appStore.getConduitId(clientId, true);
        } catch (error) {
            // Rather twice than lost.
            this.errorReporter.handleThrottled("EVENTSUB", "Could not check the conduit of an EventSub message, delivering it anyway", error);
            return true;
        }

        if (!conduitId || conduitId === transport.conduit_id) return true;

        this.logger.debug("EVENTSUB", `${subscription.type} event from foreign conduit ${transport.conduit_id} dropped (application ${clientId} uses ${conduitId})`);
        return false;
    }

    /** A user revoked the authorization – Twitch deletes the subscriptions itself. */
    private async userAuthorizationRevokeEvent(clientId: string, event: UserAuthorizationRevokeEvent): Promise<void> {
        await this.appStore.removeAuthorizedUser(clientId, event.user_id);
    }
}
