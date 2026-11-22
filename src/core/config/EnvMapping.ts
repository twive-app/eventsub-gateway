import z from "zod";

// Turn the raw environment strings into typed values.
export const envParsers = {
    text: z.string(),
    integer: z.coerce.number().int(),
    flag: z.stringbool(),
    list: z.string().transform((value: string): string[] =>
        value.split(",").map((item: string): string => item.trim()).filter(Boolean),
    ),
} as const;

export interface EnvMapping {
    variable: string;
    path: string[];
    parser: keyof typeof envParsers;
    file?: boolean;
    required?: boolean;
}

// Environment variable → config path; `file` allows <NAME>_FILE, `required` means there is no default.
export const envMappings: EnvMapping[] = [
    {
        variable: "ENVIRONMENT",
        path: ["environment"],
        parser: "text",
    },
    {
        variable: "REDIS_HOST",
        path: ["redis", "host"],
        parser: "text",
    },
    {
        variable: "REDIS_PORT",
        path: ["redis", "port"],
        parser: "integer",
    },
    {
        variable: "REDIS_USERNAME",
        path: ["redis", "username"],
        parser: "text",
    },
    {
        variable: "REDIS_PASSWORD",
        path: ["redis", "password"],
        parser: "text",
        file: true,
    },
    {
        variable: "REDIS_DB",
        path: ["redis", "db"],
        parser: "integer",
    },
    {
        variable: "REDIS_KEY_PREFIX",
        path: ["redis", "keyPrefix"],
        parser: "text",
    },
    {
        variable: "SERVER_HOST",
        path: ["server", "host"],
        parser: "text",
    },
    {
        variable: "SERVER_PORT",
        path: ["server", "port"],
        parser: "integer",
    },
    {
        variable: "TRUSTED_PROXIES",
        path: ["server", "trustedProxies"],
        parser: "list",
    },
    {
        variable: "GATEWAY_HOST",
        path: ["gateway", "host"],
        parser: "text",
    },
    {
        variable: "GATEWAY_PORT",
        path: ["gateway", "port"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_HEARTBEAT_INTERVAL",
        path: ["gateway", "heartbeatInterval"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_IDENTIFY_TIMEOUT",
        path: ["gateway", "identifyTimeout"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_RESUME_TIMEOUT",
        path: ["gateway", "resumeTimeout"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_REPLAY_BUFFER_SIZE",
        path: ["gateway", "replayBufferSize"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_MAX_PAYLOAD_SIZE",
        path: ["gateway", "maxPayloadSize"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_RATE_LIMIT_MAX_MESSAGES",
        path: ["gateway", "rateLimit", "maxMessages"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_RATE_LIMIT_WINDOW_MS",
        path: ["gateway", "rateLimit", "windowMs"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_MAX_CONNECTIONS",
        path: ["gateway", "maxConnections"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_MAX_CONNECTIONS_PER_IP",
        path: ["gateway", "maxConnectionsPerIp"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_IPV6_PREFIX_LENGTH",
        path: ["gateway", "ipv6PrefixLength"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_AUTH_FAILURE_LIMIT",
        path: ["gateway", "authFailure", "limit"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_AUTH_FAILURE_WINDOW_MS",
        path: ["gateway", "authFailure", "windowMs"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_INACTIVE_APP_DAYS",
        path: ["gateway", "inactiveAppDays"],
        parser: "integer",
    },
    {
        variable: "GATEWAY_APP_RETENTION_DAYS",
        path: ["gateway", "appRetentionDays"],
        parser: "integer",
    },
    {
        variable: "HEALTH_PUSH_URL",
        path: ["health", "pushUrl"],
        parser: "text",
        file: true,
    },
    {
        variable: "HEALTH_PUSH_INTERVAL",
        path: ["health", "pushInterval"],
        parser: "integer",
    },
    {
        variable: "METRICS_TOKEN",
        path: ["metrics", "token"],
        parser: "text",
        file: true,
    },
    {
        variable: "LOG_DEBUG",
        path: ["logging", "debug"],
        parser: "flag",
    },
    {
        variable: "LOG_FORMAT",
        path: ["logging", "format"],
        parser: "text",
    },
    {
        variable: "TWITCH_WEBHOOK_CALLBACK_URL",
        path: ["twitch", "webhook", "callbackURL"],
        parser: "text",
        required: true,
    },
    {
        variable: "TWITCH_WEBHOOK_SECRET",
        path: ["twitch", "webhook", "secretKey"],
        parser: "text",
        file: true,
        required: true,
    },
];
