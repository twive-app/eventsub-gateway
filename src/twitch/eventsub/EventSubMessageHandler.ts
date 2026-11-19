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
import type {AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubPublicSubscriptionManager} from "@twitch/eventsub/EventSubPublicSubscriptionManager.ts";
import type {EventSubScopeService} from "@twitch/eventsub/EventSubScopeService.ts";
import type {EventSubUserSubscriptionManager} from "@twitch/eventsub/EventSubUserSubscriptionManager.ts";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";

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

/** Handles verified EventSub messages: forwards events to the sessions and hands grants, revokes and revocations to the managers. */
@Bean()
export class EventSubMessageHandler {
    @Autowired()
    private sessionDispatcher!: SessionDispatcher;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private eventSubUserSubscriptionManager!: EventSubUserSubscriptionManager;

    @Autowired()
    private eventSubPublicSubscriptionManager!: EventSubPublicSubscriptionManager;

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
            case EventSubSubscriptionType.UserAuthorizationGrant:
                await this.eventSubUserSubscriptionManager.userGranted(clientId, (notification.event as UserAuthorizationGrantEvent).user_id);
                break;

            case EventSubSubscriptionType.UserAuthorizationRevoke:
                await this.eventSubUserSubscriptionManager.userRevoked(clientId, (notification.event as UserAuthorizationRevokeEvent).user_id);
                break;
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
            await this.eventSubPublicSubscriptionManager.forgetPublicSubscription(clientId, subscription);
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
        const userId: string | null = EventSubSubscriptionHelper.getConditionUserId(subscription);

        switch (subscription.status) {
            // A password change revokes everything without revoking the app – a real revoke finds no scopes and stops.
            case EventSubSubscriptionStatus.AuthorizationRevoked:
            case EventSubSubscriptionStatus.BetaMaintenance:
                if (userId) this.eventSubUserSubscriptionManager.resyncUser(clientId, userId);
                return;

            // The account is gone. A bot chat subscription doesn't tell whether it was the channel or the bot.
            case EventSubSubscriptionStatus.UserRemoved:
                if (!userId || this.eventSubScopeService.getBotUserId(subscription) !== null) return;
                await this.eventSubUserSubscriptionManager.userRemoved(clientId, userId);
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
}
