import z from "zod";
import {EventSubSubscriptionType} from "twitch-dev-types";

/** Opcodes in the order they are used: HELLO → IDENTIFY/RESUME → DISPATCH ↔ HEARTBEAT → RECONNECT/INVALID_SESSION. */
export enum GatewayOpCode {
    Hello = 0,
    Identify = 1,
    Resume = 2,
    Dispatch = 3,
    Heartbeat = 4,
    HeartbeatAck = 5,
    Reconnect = 6,
    InvalidSession = 7,
}

/** Close codes of the gateway (4000–4011), documented in docs/GATEWAY.md. */
export enum GatewayCloseCode {
    UnknownError = 4000,
    UnknownOpCode = 4001,
    DecodeError = 4002,
    NotAuthenticated = 4003,
    AuthenticationFailed = 4004,
    AlreadyAuthenticated = 4005,
    InvalidSequence = 4006,
    RateLimited = 4007,
    HeartbeatTimeout = 4008,
    InvalidApiVersion = 4009,
    InvalidEvents = 4010,
    SessionReplaced = 4011,
}

/** Dispatch events of the gateway itself – every EventSub type is dispatched as well. */
export enum GatewayDispatchEvent {
    Ready = "READY",
    Resumed = "RESUMED",
    SubscriptionRevoked = "SUBSCRIPTION_REVOKED",
}

/** One frame: opcode, data, sequence number and event name (s and t only for DISPATCH). */
export interface GatewayPayload<D = unknown> {
    op: GatewayOpCode;
    d: D | null;
    s: number | null;
    t: string | null;
}

/** HELLO: how often the client has to send HEARTBEAT. */
export interface GatewayHelloData {
    heartbeatInterval: number;
}

/** INVALID_SESSION: whether RESUME can still work, and why. */
export interface GatewayInvalidSessionData {
    resumable: boolean;
    message: string;
}

/** READY: the new session and everything about the application. */
export interface GatewayReadyData {
    v: number;
    sessionId: string;
    application: {
        clientId: string;
        botUserId: string | null;
        conduitId: string | null;
        accessToken: string;
    };
    authorizedUserIds: string[];
    events: string[] | null;
}

/** Every client message: an integer opcode and its data. */
export const gatewayBasePayloadSchema = z.object({
    op: z.number().int(),
    d: z.unknown().optional(),
});

// Both IDENTIFY and RESUME carry the credentials of the Twitch application.
const credentialsSchema = {
    clientId: z.string().min(1).max(64),
    clientSecret: z.string().min(1).max(128),
} satisfies z.ZodRawShape;

/** IDENTIFY: credentials, optional bot user and event filter. */
export const gatewayIdentifySchema = z.object({
    ...credentialsSchema,
    botUserId: z.string().regex(/^\d{1,20}$/).nullable().optional(),
    events: z.array(z.string().min(1).max(100)).max(250).optional(),
});

/** RESUME: credentials, the session and the last sequence number the client received. */
export const gatewayResumeSchema = z.object({
    ...credentialsSchema,
    sessionId: z.uuid(),
    seq: z.number().int().min(0),
});

/** HEARTBEAT: the last sequence number or null. */
export const gatewayHeartbeatSchema = z.number().int().min(0).nullable().optional();

export type GatewayBasePayload = z.infer<typeof gatewayBasePayloadSchema>;
export type GatewayHeartbeatData = z.infer<typeof gatewayHeartbeatSchema>;
export type GatewayIdentifyData = z.infer<typeof gatewayIdentifySchema>;
export type GatewayResumeData = z.infer<typeof gatewayResumeSchema>;

/** EventSub type to dispatch event name: channel.chat.message → CHANNEL_CHAT_MESSAGE. */
function toDispatchEventName(subscriptionType: string): string {
    return subscriptionType.toUpperCase().replaceAll(".", "_");
}

/** A frame with all four fields. */
function createPayload<D>(op: GatewayOpCode, d: D | null = null, t: string | null = null, s: number | null = null): GatewayPayload<D> {
    return {op, d, s, t};
}

/** Constants and helpers of the gateway protocol. */
export const GatewayProtocol = {
    version: 1,
    // A close with one of these ends the session, every other close keeps it resumable.
    sessionInvalidatingCloseCodes: new Set<number>([
        1000,
        1001,
        GatewayCloseCode.AuthenticationFailed,
        GatewayCloseCode.InvalidSequence,
        GatewayCloseCode.InvalidApiVersion,
        GatewayCloseCode.InvalidEvents,
    ]),
    // Not sequenced, never buffered and never filtered.
    lifecycleEvents: new Set<string>([
        GatewayDispatchEvent.Ready,
        GatewayDispatchEvent.Resumed,
    ]),
    // Every name a client may put into the `events` filter of IDENTIFY.
    dispatchEventNames: new Set<string>([
        ...Object.values(EventSubSubscriptionType).map(toDispatchEventName),
        GatewayDispatchEvent.SubscriptionRevoked,
    ]),
    toDispatchEventName,
    createPayload,
} as const;
