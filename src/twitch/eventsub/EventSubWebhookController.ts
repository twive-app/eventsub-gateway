import type {BunRequest} from "bun";
import {
    EventSubWebhookMessageType,
    EventSubWebhookRequestHeader,
    type EventSubWebhookNotificationRequestBody,
    type EventSubWebhookRevokeSubscriptionRequestBody,
    type EventSubWebhookVerificationChallengeRequestBody,
} from "twitch-dev-types";
import crypto from "node:crypto";
import {Autowired, Bean, Route, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import {HttpResponses} from "@core/http/HttpResponses.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";
import {clientIdPattern} from "@gateway/GatewayProtocol.ts";
import type {AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubMessageHandler} from "@twitch/eventsub/EventSubMessageHandler.ts";
import type {EventSubWebhookStore} from "@twitch/eventsub/EventSubWebhookStore.ts";

// Older messages are dropped (replay protection) – Twitch itself retries for a shorter time.
const maxMessageAgeMs: number = 10 * 60 * 1000;
const hmacPrefix: string = "sha256=";
// Message types Twitch sends – anything else is counted as "unknown", so a request can't add series.
const knownMessageTypes: Set<string> = new Set<string>(Object.values(EventSubWebhookMessageType));
// How long a shutdown waits for messages that are still being processed.
const shutdownWaitMs: number = 5000;

/** POST /twitch/webhook/callback: verifies Twitch's signature and hands the messages to the handler. */
@Bean()
export class EventSubWebhookController {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private eventSubWebhookStore!: EventSubWebhookStore;

    @Autowired()
    private eventSubMessageHandler!: EventSubMessageHandler;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private metricsRegistry!: MetricsRegistry;

    // Messages answered with 204 whose processing still runs – Twitch won't send them again.
    private readonly processing: Set<Promise<void>> = new Set<Promise<void>>();

    /** Verifies, de-duplicates and answers quickly – the processing runs in the background. */
    @Route("POST", "/twitch/webhook/callback")
    public async handleCallback(request: BunRequest): Promise<Response> {
        // client_id in our callback URL tells which application the message belongs to.
        const clientId: string | null = new URL(request.url).searchParams.get("client_id");

        const signature: string | null = request.headers.get(EventSubWebhookRequestHeader.TwitchEventSubMessageSignature);
        const messageId: string | null = request.headers.get(EventSubWebhookRequestHeader.TwitchEventSubMessageId);
        const timestamp: string | null = request.headers.get(EventSubWebhookRequestHeader.TwitchEventSubMessageTimestamp);
        const messageType: EventSubWebhookMessageType | null = request.headers.get(EventSubWebhookRequestHeader.TwitchEventSubMessageType) as EventSubWebhookMessageType | null;

        if (!signature || !messageId || !timestamp || !messageType) {
            this.logger.warn("WEBHOOK", "Rejected: EventSub headers missing (403)", {app: clientId});
            this.count(messageType, "missing_headers");
            return new Response(null, {status: 403});
        }

        // The signature covers the raw bytes – never re-serialized JSON.
        const rawBody: string = await request.text();
        const secret: string = this.configManager.get().twitch.webhook.secretKey;

        if (!this.verifySignature(secret, messageId, timestamp, rawBody, signature)) {
            this.logger.warn("WEBHOOK", "Rejected: invalid signature (403) – TWITCH_WEBHOOK_SECRET changed?", {id: messageId, app: clientId});
            this.count(messageType, "invalid_signature");
            return new Response(null, {status: 403});
        }

        let body: unknown;
        try {
            body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
        } catch (error) {
            this.count(messageType, "invalid_json");
            return HttpResponses.jsonError(400, "Bad Request", error instanceof Error ? error.message : "Invalid JSON");
        }

        if (messageType === EventSubWebhookMessageType.WebhookCallbackVerification) {
            // Webhook subscriptions send `subscription` along, a conduit shard verification only the `challenge`.
            const verification: Partial<EventSubWebhookVerificationChallengeRequestBody> = body as Partial<EventSubWebhookVerificationChallengeRequestBody>;
            if (typeof verification.challenge !== "string" || verification.challenge.length === 0) {
                this.logger.warn("WEBHOOK", "Verification without challenge (400)", {app: clientId});
                this.count(messageType, "missing_challenge");
                return HttpResponses.jsonError(400, "Bad Request", "Missing challenge");
            }

            this.logger.success("WEBHOOK", "Verification challenge answered", {app: clientId, for: verification.subscription?.type ?? "conduit shard"});
            this.count(messageType, "answered");
            return new Response(verification.challenge, {status: 200, headers: {"Content-Type": "text/plain"}});
        }

        if (this.isOutdated(timestamp)) {
            this.logger.warn("WEBHOOK", "Dropped: older than 10 minutes", {id: messageId, app: clientId, sent: timestamp});
            this.count(messageType, "outdated");
            return new Response(null, {status: 204});
        }

        // Our callback URLs carry a valid client id – anything else isn't ours and never reaches a Redis key.
        if (!clientId || !clientIdPattern.test(clientId)) {
            this.logger.warn("WEBHOOK", "Dropped: callback URL without a valid client_id", {id: messageId, app: clientId});
            this.count(messageType, "invalid_client_id");
            return new Response(null, {status: 204});
        }

        // Before the de-duplication, so Twitch's retries are refused as well.
        if (await this.hasNoConduit(clientId)) {
            this.logger.debug("WEBHOOK", "Refused: app has no conduit (410)", {id: messageId, app: clientId});
            this.count(messageType, "no_conduit");
            return new Response(null, {status: 410});
        }

        // Twitch may deliver a message more than once.
        if (!(await this.isFirstDelivery(messageId))) {
            this.logger.debug("WEBHOOK", "Dropped: duplicate", {id: messageId, app: clientId});
            this.count(messageType, "duplicate");
            return new Response(null, {status: 204});
        }

        // Answer 204 right away, Twitch expects a response within a few seconds.
        switch (messageType) {
            case EventSubWebhookMessageType.Revocation: {
                const revocation: EventSubWebhookRevokeSubscriptionRequestBody = body as EventSubWebhookRevokeSubscriptionRequestBody;

                this.logger.info("WEBHOOK", "Subscription revoked by Twitch", {app: clientId, type: revocation.subscription.type, reason: revocation.subscription.status});
                this.count(messageType, "accepted");
                this.process(this.eventSubMessageHandler.handleRevocation(clientId, revocation), clientId, messageId);
                return new Response(null, {status: 204});
            }

            case EventSubWebhookMessageType.Notification: {
                const notification: EventSubWebhookNotificationRequestBody = body as EventSubWebhookNotificationRequestBody;

                this.logger.debug("WEBHOOK", "Notification", {app: clientId, type: notification.subscription.type, id: messageId});
                this.count(messageType, "accepted");
                this.process(this.eventSubMessageHandler.handleNotification(clientId, notification), clientId, messageId);
                return new Response(null, {status: 204});
            }

            default:
                this.logger.warn("WEBHOOK", "Dropped: unknown message type", {app: clientId, type: String(messageType)});
                this.count(messageType, "unknown_type");
                return new Response(null, {status: 204});
        }
    }

    /**
     * On shutdown, after the HTTP server stopped accepting webhooks and before Redis closes: waits (at most 5 s) for the
     * messages still being processed – a grant cut off here would be lost, Twitch already got its 204.
     */
    @ShutdownHook(30)
    public async finishProcessing(waitMs: number = shutdownWaitMs): Promise<void> {
        if (this.processing.size === 0) return;

        this.logger.info("WEBHOOK", "Waiting for messages still being processed", {count: this.processing.size});
        const finished: boolean = await Promise.race([
            Promise.allSettled([...this.processing]).then((): boolean => true),
            Bun.sleep(waitMs).then((): boolean => false),
        ]);
        if (!finished) this.logger.warn("WEBHOOK", "Shutting down while messages are still being processed", {count: this.processing.size});
    }

    /**
     * Whether the app has no conduit (inactive or unknown). Refusing its messages makes Twitch disable the shard of a
     * conduit the gateway couldn't delete – Twitch deletes the conduit with its subscriptions after 72 hours.
     */
    private async hasNoConduit(clientId: string): Promise<boolean> {
        try {
            return await this.appStore.getConduitId(clientId) === null;
        } catch (error) {
            // Rather delivered than refused.
            this.logger.warnThrottled("WEBHOOK", "Could not check the conduit of an app, accepting its message", {app: clientId}, error);
            return false;
        }
    }

    /** Counts a webhook request by its message type and what happened to it. */
    private count(messageType: string | null, result: string): void {
        const type: string = messageType && knownMessageTypes.has(messageType) ? messageType : "unknown";
        this.metricsRegistry.increment("webhook_messages", "Webhook requests from Twitch by message type and result", {type, result});
    }

    /** Runs the processing in the background and remembers it until it's done; errors are logged with the message id. */
    private process(task: Promise<void>, clientId: string, messageId: string): void {
        const tracked: Promise<void> = task.catch((error: unknown): void => {
            this.logger.error("WEBHOOK", "Could not process a message", {id: messageId, app: clientId}, error);
        }).finally((): void => {
            this.processing.delete(tracked);
        });
        this.processing.add(tracked);
    }

    /** Older than 10 minutes, or no valid timestamp. */
    private isOutdated(timestamp: string): boolean {
        const sentAt: number = Date.parse(timestamp);
        return Number.isNaN(sentAt) || Date.now() - sentAt > maxMessageAgeMs;
    }

    /** Marks a message as delivered; true the first time – if Redis is down, process it anyway. */
    private async isFirstDelivery(messageId: string): Promise<boolean> {
        try {
            return await this.eventSubWebhookStore.markFirstDelivery(messageId, maxMessageAgeMs / 1000);
        } catch (error) {
            this.logger.warnThrottled("WEBHOOK", "Could not check for duplicates, processing the message anyway", {id: messageId}, error);
            return true;
        }
    }

    /** The signature Twitch sends: HMAC-SHA256 over message id + timestamp + raw body. */
    private createSignature(secret: string, messageId: string, timestamp: string, rawBody: string): string {
        return hmacPrefix + crypto.createHmac("sha256", secret).update(messageId + timestamp + rawBody).digest("hex");
    }

    /** Compares two signatures in constant time. */
    private verifySignature(secret: string, messageId: string, timestamp: string, rawBody: string, signature: string): boolean {
        const expected: Buffer = Buffer.from(this.createSignature(secret, messageId, timestamp, rawBody));
        const received: Buffer = Buffer.from(signature);

        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    }
}
