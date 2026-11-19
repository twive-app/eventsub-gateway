import {beforeEach, describe, expect, test} from "bun:test";
import crypto from "node:crypto";
import type {BunRequest} from "bun";
import {EventSubWebhookController} from "@twitch/eventsub/EventSubWebhookController.ts";
import {provideBean, testCallbackUrl, testWebhookSecret} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";

interface Delivery {
    url?: string;
    secret?: string;
    messageId?: string;
    timestamp?: string;
    type?: string;
    body?: string;
    headers?: Record<string, string | undefined>;
}

let controller: EventSubWebhookController;
let handled: string[];
let delivered: Set<string>;
let conduitId: string | null;
let logger: LoggerMockup;

/** A webhook request as Twitch sends it, signed with the given secret. */
function webhook(delivery: Delivery = {}): BunRequest {
    const messageId: string = delivery.messageId ?? crypto.randomUUID();
    const timestamp: string = delivery.timestamp ?? new Date().toISOString();
    const body: string = delivery.body ?? JSON.stringify({subscription: {type: "stream.online", status: "enabled"}, event: {broadcaster_user_id: "1"}});
    const signature: string = `sha256=${crypto.createHmac("sha256", delivery.secret ?? testWebhookSecret).update(messageId + timestamp + body).digest("hex")}`;

    const headers: Record<string, string | undefined> = {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": delivery.type ?? "notification",
        ...delivery.headers,
    };
    const defined: Record<string, string> = Object.fromEntries(Object.entries(headers).filter((entry: [string, string | undefined]): boolean => entry[1] !== undefined)) as Record<string, string>;

    return new Request(delivery.url ?? `${testCallbackUrl}?client_id=${clientId}`, {method: "POST", headers: defined, body}) as BunRequest;
}

beforeEach((): void => {
    handled = [];
    delivered = new Set<string>();
    conduitId = "conduit-1";

    provideBean("configManager", new ConfigManagerMockup());
    logger = new LoggerMockup();
    provideBean("logger", logger);
    provideBean("appStore", {getConduitId: async (): Promise<string | null> => conduitId});
    provideBean("eventSubWebhookStore", {
        markFirstDelivery: async (messageId: string): Promise<boolean> => {
            if (delivered.has(messageId)) return false;
            delivered.add(messageId);
            return true;
        },
    });
    provideBean("eventSubMessageHandler", {
        handleNotification: async (app: string): Promise<void> => {
            handled.push(`notification:${app}`);
        },
        handleRevocation: async (app: string): Promise<void> => {
            handled.push(`revocation:${app}`);
        },
    });
    controller = new EventSubWebhookController();
});

describe("EventSubWebhookController", (): void => {
    test("a signed notification is answered with 204 and handed to the handler", async (): Promise<void> => {
        expect((await controller.handleCallback(webhook())).status).toBe(204);
        expect(handled).toEqual([`notification:${clientId}`]);
    });

    test("a wrong signature is rejected with 403", async (): Promise<void> => {
        expect((await controller.handleCallback(webhook({secret: "another-secret-123"}))).status).toBe(403);
        expect(handled).toEqual([]);
    });

    test("a changed body breaks the signature", async (): Promise<void> => {
        const request: BunRequest = webhook();
        const forged: BunRequest = new Request(request.url, {method: "POST", headers: request.headers, body: "{\"event\":{}}"}) as BunRequest;
        expect((await controller.handleCallback(forged)).status).toBe(403);
    });

    test("missing EventSub headers are rejected with 403", async (): Promise<void> => {
        expect((await controller.handleCallback(webhook({headers: {"Twitch-Eventsub-Message-Signature": undefined}}))).status).toBe(403);
    });

    test("the verification challenge is answered with the challenge itself", async (): Promise<void> => {
        const response: Response = await controller.handleCallback(webhook({type: "webhook_callback_verification", body: JSON.stringify({challenge: "pong"})}));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("pong");
    });

    test("a verification without challenge is a 400", async (): Promise<void> => {
        expect((await controller.handleCallback(webhook({type: "webhook_callback_verification", body: "{}"}))).status).toBe(400);
    });

    test("messages older than 10 minutes are dropped (replay protection)", async (): Promise<void> => {
        const old: string = new Date(Date.now() - 11 * 60 * 1000).toISOString();
        expect((await controller.handleCallback(webhook({timestamp: old}))).status).toBe(204);
        expect(handled).toEqual([]);
    });

    test("a duplicate is processed only once", async (): Promise<void> => {
        await controller.handleCallback(webhook({messageId: "m-1"}));
        await controller.handleCallback(webhook({messageId: "m-1"}));
        expect(handled).toHaveLength(1);
    });

    test.each([
        ["without client_id", testCallbackUrl],
        ["with an invalid client_id", `${testCallbackUrl}?client_id=abc%0Adef`],
    ])("a callback URL %s is dropped", async (_name: string, url: string): Promise<void> => {
        expect((await controller.handleCallback(webhook({url}))).status).toBe(204);
        expect(handled).toEqual([]);
    });

    test("an app without conduit gets 410 so Twitch disables the shard – before the de-duplication", async (): Promise<void> => {
        conduitId = null;
        expect((await controller.handleCallback(webhook({messageId: "m-2"}))).status).toBe(410);
        expect(delivered.has("m-2")).toBe(false);
    });

    test("a revocation is handed to the handler", async (): Promise<void> => {
        const body: string = JSON.stringify({subscription: {type: "channel.cheer", status: "authorization_revoked"}});
        expect((await controller.handleCallback(webhook({type: "revocation", body}))).status).toBe(204);
        expect(handled).toEqual([`revocation:${clientId}`]);
    });
});

describe("EventSubWebhookController on shutdown", (): void => {
    /** A handler whose processing runs until release() is called. */
    function slowHandler(): () => void {
        let release: () => void = (): void => undefined;
        const running: Promise<void> = new Promise<void>((resolve: () => void): void => {
            release = resolve;
        });
        provideBean("eventSubMessageHandler", {
            handleNotification: async (app: string): Promise<void> => {
                await running;
                handled.push(`notification:${app}`);
            },
        });
        controller = new EventSubWebhookController();
        return release;
    }

    test("waits for messages still being processed", async (): Promise<void> => {
        const release: () => void = slowHandler();
        expect((await controller.handleCallback(webhook())).status).toBe(204);
        expect(handled).toEqual([]);

        setTimeout(release, 20);
        await controller.finishProcessing(2000);

        expect(handled).toEqual([`notification:${clientId}`]);
        expect(logger.messages("warn")).toEqual([]);
    });

    test("waits at most the given time, then shuts down with a warning", async (): Promise<void> => {
        slowHandler();
        await controller.handleCallback(webhook());

        await controller.finishProcessing(20);

        expect(handled).toEqual([]);
        expect(logger.messages("warn")).toEqual(["Shutting down while messages are still being processed"]);
    });

    test("nothing running – returns right away", async (): Promise<void> => {
        await controller.handleCallback(webhook());
        await Bun.sleep(0);

        await controller.finishProcessing(2000);
        expect(logger.messages("info")).toEqual([]);
    });
});
