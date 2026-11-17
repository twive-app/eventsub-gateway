import {describe, expect, test} from "bun:test";
import {
    GatewayDispatchEvent,
    GatewayOpCode,
    GatewayProtocol,
    gatewayIdentifySchema,
    gatewayResumeSchema,
} from "@gateway/GatewayProtocol.ts";

describe("GatewayProtocol", (): void => {
    test("turns EventSub types into dispatch names", (): void => {
        expect(GatewayProtocol.toDispatchEventName("channel.chat.message")).toBe("CHANNEL_CHAT_MESSAGE");
        expect(GatewayProtocol.toDispatchEventName("stream.online")).toBe("STREAM_ONLINE");
    });

    test("serializeDispatch builds exactly the JSON of createPayload", (): void => {
        const data: unknown = {text: "quote \" backslash \\ unicode ✓", nested: {list: [1, null]}};
        const expected: string = JSON.stringify(GatewayProtocol.createPayload(GatewayOpCode.Dispatch, data, "CHANNEL_CHAT_MESSAGE", 42));

        expect(GatewayProtocol.serializeDispatch("CHANNEL_CHAT_MESSAGE", JSON.stringify(data), 42)).toBe(expected);
        expect(GatewayProtocol.serializeDispatch("READY", "null", null)).toBe(JSON.stringify(GatewayProtocol.createPayload(GatewayOpCode.Dispatch, null, "READY", null)));
    });

    test("the HEARTBEAT_ACK frame is a complete payload", (): void => {
        expect(JSON.parse(GatewayProtocol.heartbeatAckFrame)).toEqual({op: GatewayOpCode.HeartbeatAck, d: null, s: null, t: null});
    });

    test("clients may filter for the gateway's own events, but not for READY", (): void => {
        expect(GatewayProtocol.dispatchEventNames.has(GatewayDispatchEvent.SubscriptionRevoked)).toBe(true);
        expect(GatewayProtocol.dispatchEventNames.has(GatewayDispatchEvent.SubscriptionFailed)).toBe(true);
        expect(GatewayProtocol.dispatchEventNames.has("CHANNEL_CHAT_MESSAGE")).toBe(true);
        expect(GatewayProtocol.dispatchEventNames.has(GatewayDispatchEvent.Ready)).toBe(false);
    });

    describe("IDENTIFY", (): void => {
        const valid: Record<string, unknown> = {clientId: "gp762nuuoqcoxypju8c569th9wz7q5", clientSecret: "secret"};

        test("accepts credentials, a numeric botUserId and an event filter", (): void => {
            expect(gatewayIdentifySchema.safeParse({...valid, botUserId: "123", events: ["STREAM_ONLINE"]}).success).toBe(true);
            expect(gatewayIdentifySchema.safeParse({...valid, botUserId: null}).success).toBe(true);
        });

        test.each([
            ["a client id with a colon", {...valid, clientId: "abc:def"}],
            ["a client id with a line break", {...valid, clientId: "abc\ndef"}],
            ["an empty secret", {...valid, clientSecret: ""}],
            ["a secret over 128 characters", {...valid, clientSecret: "x".repeat(129)}],
            ["a non-numeric botUserId", {...valid, botUserId: "bot"}],
            ["more than 250 events", {...valid, events: new Array<string>(251).fill("STREAM_ONLINE")}],
        ])("rejects %s", (_name: string, payload: Record<string, unknown>): void => {
            expect(gatewayIdentifySchema.safeParse(payload).success).toBe(false);
        });
    });

    test("RESUME needs a UUID session id and a non-negative seq", (): void => {
        const valid: Record<string, unknown> = {clientId: "abc", clientSecret: "secret", sessionId: crypto.randomUUID(), seq: 0};

        expect(gatewayResumeSchema.safeParse(valid).success).toBe(true);
        expect(gatewayResumeSchema.safeParse({...valid, sessionId: "not-a-uuid"}).success).toBe(false);
        expect(gatewayResumeSchema.safeParse({...valid, seq: -1}).success).toBe(false);
    });
});
