import net from "node:net";
import z from "zod";

/** Whether a value is an IPv4/IPv6 address or a CIDR range. */
function isAddressOrCidr(value: string): boolean {
    const parts: string[] = value.split("/");
    const family: number = net.isIP(parts[0]);
    if (family === 0 || parts.length > 2) return false;
    return parts.length === 1 || (/^\d{1,3}$/.test(parts[1]) && Number(parts[1]) <= (family === 4 ? 32 : 128));
}

// Every option with its default – the single source of truth of the configuration.
const configFieldsSchema = z.object({
    environment: z.string().default("prod"),
    redis: z.object({
        host: z.string().default("localhost"),
        port: z.number().int().min(1).max(65535).default(6379),
        username: z.string().default(""),
        password: z.string().default(""),
        db: z.number().int().min(0).default(0),
        keyPrefix: z.string().max(64).regex(/^([A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*)?$/, {
            error: "only letters, digits, \"_\", \".\", \"-\" and \":\" between parts (e.g. twive or twive:prod)",
        }).default(""),
    }).prefault({}),
    server: z.object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(3000),
        trustedProxies: z.array(z.string().refine(isAddressOrCidr, {
            error: (issue: z.core.$ZodRawIssue): string => `invalid IP address or CIDR "${String(issue.input)}"`,
        })).default([]),
    }).prefault({}),
    gateway: z.object({
        host: z.string().optional(),
        port: z.number().int().min(1).max(65535).default(3001),
        heartbeatInterval: z.number().int().min(5000).default(41250),
        identifyTimeout: z.number().int().min(1000).default(30000),
        resumeTimeout: z.number().int().min(0).default(120000),
        replayBufferSize: z.number().int().min(0).default(500),
        maxPayloadSize: z.number().int().min(512).default(4096),
        rateLimit: z.object({
            maxMessages: z.number().int().min(1).default(120),
            windowMs: z.number().int().min(1000).default(60000),
        }).prefault({}),
        maxConnections: z.number().int().min(0).default(0),
        maxConnectionsPerIp: z.number().int().min(0).default(100),
        ipv6PrefixLength: z.number().int().min(32).max(128).default(64),
        authFailure: z.object({
            limit: z.number().int().min(0).default(10),
            windowMs: z.number().int().min(1000).default(600000),
        }).prefault({}),
        // Days without a client: first the conduit is deleted, later the whole app; 0 = never.
        inactiveAppDays: z.number().int().min(0).default(30),
        appRetentionDays: z.number().int().min(0).default(180),
    }).refine((gateway: {inactiveAppDays: number; appRetentionDays: number}): boolean => (
        gateway.appRetentionDays === 0 || gateway.inactiveAppDays === 0 || gateway.appRetentionDays >= gateway.inactiveAppDays
    ), {
        path: ["appRetentionDays"],
        error: "must be 0 or at least GATEWAY_INACTIVE_APP_DAYS",
    }).prefault({}),
    health: z.object({
        pushUrl: z.url({
            protocol: /^https?$/,
            error: "must be an http:// or https:// URL",
        }).optional(),
        pushInterval: z.number().int().min(10).default(60),
    }).prefault({}),
    metrics: z.object({
        // Bearer token of GET /metrics – without one the endpoint is off.
        token: z.string().min(16, {
            error: "must have at least 16 characters",
        }).optional(),
    }).prefault({}),
    logging: z.object({
        debug: z.boolean().default(false),
        // pretty: one colored line per event; JSON: one JSON object per line, for log collectors.
        format: z.enum(["pretty", "json"], {
            error: "must be pretty or json",
        }).default("pretty"),
    }).prefault({}),
    twitch: z.object({
        webhook: z.object({
            callbackURL: z.url(),
            secretKey: z.string().min(10).max(100),
        }),
    }),
});

type ConfigFields = z.infer<typeof configFieldsSchema>;

interface ResolvedConfig extends ConfigFields {
    gateway: ConfigFields["gateway"] & {
        host: string;
    };
}

// GATEWAY_HOST falls back to SERVER_HOST.
export const configSchema = configFieldsSchema.transform((config: ConfigFields): ResolvedConfig => ({
    ...config,
    gateway: {
        ...config.gateway,
        host: config.gateway.host ?? config.server.host,
    },
}));
