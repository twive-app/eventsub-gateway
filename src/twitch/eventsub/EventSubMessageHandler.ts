import {
    EventSubSubscriptionStatus,
    EventSubSubscriptionType,
    type EventSubWebhookNotificationRequestBody,
    type EventSubWebhookRevokeSubscriptionRequestBody,
    type UserAuthorizationGrantEvent,
    type UserAuthorizationRevokeEvent,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import {GatewayDispatchEvent, GatewayProtocol} from "@gateway/GatewayProtocol.ts";
import type {SessionDispatcher} from "@gateway/session/SessionDispatcher.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";
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
    private eventSubScopeService!: EventSubScopeService;

    @Autowired()
    private logger!: Logger;

    // type@version Twitch removed – logged once, not for every subscription.
    private readonly removedVersions: Set<string> = new Set<string>();

    /** A notification: dispatch it to every session of the app, then the grant/revoke bookkeeping. */
    public async handleNotification(clientId: string, notification: EventSubWebhookNotificationRequestBody): Promise<void> {
        if (!await this.isFromCurrentConduit(clientId, notification.subscription as EventSubDeliveredSubscription)) return;

        // Forward first – the bookkeeping (Helix calls for a grant) must not delay the event.
        this.sessionDispatcher.dispatch(clientId, GatewayProtocol.toDispatchEventName(notification.subscription.type), notification.event);

        switch (notification.subscription.type) {
            case EventSubSubscriptionType.UserAuthorizationGrant: {
                const event: UserAuthorizationGrantEvent = notification.event as UserAuthorizationGrantEvent;
                await this.eventSubSubscriptionManager.runForUser(clientId, event.user_id, "grant", (): Promise<void> => this.userAuthorizationGrantEvent(clientId, event));
                break;
            }

            case EventSubSubscriptionType.UserAuthorizationRevoke: {
                const event: UserAuthorizationRevokeEvent = notification.event as UserAuthorizationRevokeEvent;
                await this.eventSubSubscriptionManager.runForUser(clientId, event.user_id, "revoke", (): Promise<void> => this.userAuthorizationRevokeEvent(clientId, event));
                break;
            }
        }
    }

    /** A revoked subscription: tell the sessions, then act on why Twitch revoked it. */
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

        try {
            await this.eventSubSubscriptionManager.forgetPublicSubscription(clientId, subscription);
        } catch (error) {
            this.logger.warn("EVENTSUB", "Could not forget a revoked public subscription", {app: clientId, type: subscription.type}, error);
        }

        // Without these two subscriptions no new users arrive – the conduit check or the next IDENTIFY subscribes again.
        if (subscription.type === EventSubSubscriptionType.UserAuthorizationGrant ||
            subscription.type === EventSubSubscriptionType.UserAuthorizationRevoke
        ) {
            try {
                await this.appStore.update(clientId, {hasAuthorizationSubscriptions: false});
            } catch (error) {
                this.logger.warn("EVENTSUB", "Could not mark the authorization subscriptions as revoked", {app: clientId}, error);
            }
            return;
        }

        await this.handleRevocationStatus(clientId, subscription);
    }

    /** What the reason of a revocation means for the gateway – the sessions already got SUBSCRIPTION_REVOKED. */
    private async handleRevocationStatus(clientId: string, subscription: EventSubWebhookRevokeSubscriptionRequestBody["subscription"]): Promise<void> {
        const userId: string | null = this.eventSubSubscriptionManager.getConditionUserId(subscription);

        switch (subscription.status) {
            // A password change revokes everything without revoking the app – a real revoke finds no scopes and stops.
            case EventSubSubscriptionStatus.AuthorizationRevoked:
            case EventSubSubscriptionStatus.BetaMaintenance:
                if (userId) this.eventSubSubscriptionManager.resyncUser(clientId, userId);
                return;

            // The account is gone. A bot chat subscription doesn't tell whether it was the channel or the bot.
            case EventSubSubscriptionStatus.UserRemoved:
                if (!userId || this.eventSubScopeService.getBotUserId(subscription) !== null) return;
                await this.eventSubSubscriptionManager.runForUser(clientId, userId, "removal", async (): Promise<void> => {
                    await this.eventSubSubscriptionManager.forgetUser(clientId, userId);
                    this.logger.info("EVENTSUB", "User no longer exists, forgotten", {app: clientId, user: userId});
                });
                return;

            // Creating it again would fail – the gateway has to learn the new version.
            case EventSubSubscriptionStatus.VersionRemoved: {
                const version: string = `${subscription.type}@${subscription.version}`;
                if (this.removedVersions.has(version)) return;
                this.removedVersions.add(version);
                this.logger.error("EVENTSUB", "Twitch removed a subscription version the gateway uses – update the gateway", {app: clientId, type: subscription.type, version: subscription.version});
                return;
            }
        }
    }

    /** A user authorized the app: subscribe to everything the granted scopes allow. */
    private async userAuthorizationGrantEvent(clientId: string, event: UserAuthorizationGrantEvent): Promise<void> {
        let app: App | null;
        try {
            app = await this.appStore.find(clientId);
        } catch (error) {
            this.logger.warn("EVENTSUB", "Authorization grant not processed: app could not be loaded", {app: clientId, user: event.user_id}, error);
            return;
        }

        if (!app) {
            this.logger.warn("EVENTSUB", "Authorization grant for an unknown app", {app: clientId, user: event.user_id});
            return;
        }

        const accessToken: string | null = await this.appAuthenticator.getAppAccessToken(clientId);
        if (!accessToken) return;

        await this.eventSubSubscriptionManager.syncUserSubscriptions(app, accessToken, event.user_id);

        // Not awaited: the reconcile restores every user – including this one, whose queue this grant still holds.
        const current: App | null = await this.appStore.find(clientId);
        if (current && current.botUserId !== app.botUserId) {
            this.eventSubSubscriptionManager.reconcileBotSubscriptions(clientId, accessToken).catch((error: unknown): void => {
                this.logger.error("EVENTSUB", "Could not move the bot chat subscriptions", {app: clientId}, error);
            });
        }
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
            this.logger.warnThrottled("EVENTSUB", "Could not check the conduit of an event, delivering it anyway", {app: clientId}, error);
            return true;
        }

        if (!conduitId || conduitId === transport.conduit_id) return true;

        this.logger.debug("EVENTSUB", "Event of an old conduit dropped", {app: clientId, type: subscription.type, conduit: transport.conduit_id, current: conduitId});
        return false;
    }

    /** A user revoked the authorization – Twitch deletes the subscriptions itself. */
    private async userAuthorizationRevokeEvent(clientId: string, event: UserAuthorizationRevokeEvent): Promise<void> {
        await this.eventSubSubscriptionManager.forgetUser(clientId, event.user_id);
    }
}
