import fs from "node:fs";
import net from "node:net";
import {Autowired, Bean, PostConstruct} from "@core/bean/BeanDecorators.ts";
import z from "zod";
import {MainError} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";

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
    }).prefault({}),
    server: z.object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(3000),
        trustedProxies: z.array(z.string().refine(isAddressOrCidr, {error: (issue: z.core.$ZodRawIssue): string => `invalid IP address or CIDR "${String(issue.input)}"`})).default([]),
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
        }).default({maxMessages: 120, windowMs: 60000}),
        maxConnections: z.number().int().min(0).default(0),
        maxConnectionsPerIp: z.number().int().min(0).default(100),
        ipv6PrefixLength: z.number().int().min(32).max(128).default(64),
        authFailure: z.object({
            limit: z.number().int().min(0).default(10),
            windowMs: z.number().int().min(1000).default(600000),
        }).prefault({}),
    }).prefault({}),
    health: z.object({
        pushUrl: z.url({protocol: /^https?$/, error: "must be an http:// or https:// URL"}).optional(),
        pushInterval: z.number().int().min(10).default(60),
    }).prefault({}),
    logging: z.object({
        debug: z.boolean().default(false),
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
    gateway: ConfigFields["gateway"] & {host: string};
}

// GATEWAY_HOST falls back to SERVER_HOST.
const configSchema = configFieldsSchema.transform((config: ConfigFields): ResolvedConfig => ({
    ...config,
    gateway: {...config.gateway, host: config.gateway.host ?? config.server.host},
}));

export type ConfigValues = z.infer<typeof configSchema>;

// Turn the raw environment strings into typed values.
const envParsers = {
    text: z.string(),
    integer: z.coerce.number().int(),
    flag: z.stringbool(),
    list: z.string().transform((value: string): string[] => value.split(",").map((item: string): string => item.trim()).filter(Boolean)),
} as const;

interface EnvMapping {
    variable: string;
    path: string[];
    parser: keyof typeof envParsers;
    file?: boolean;
    required?: boolean;
}

// Environment variable → config path; `file` allows <NAME>_FILE, `required` means there is no default.
const envMappings: EnvMapping[] = [
    {variable: "ENVIRONMENT", path: ["environment"], parser: "text"},
    {variable: "REDIS_HOST", path: ["redis", "host"], parser: "text"},
    {variable: "REDIS_PORT", path: ["redis", "port"], parser: "integer"},
    {variable: "REDIS_USERNAME", path: ["redis", "username"], parser: "text"},
    {variable: "REDIS_PASSWORD", path: ["redis", "password"], parser: "text", file: true},
    {variable: "REDIS_DB", path: ["redis", "db"], parser: "integer"},
    {variable: "SERVER_HOST", path: ["server", "host"], parser: "text"},
    {variable: "SERVER_PORT", path: ["server", "port"], parser: "integer"},
    {variable: "TRUSTED_PROXIES", path: ["server", "trustedProxies"], parser: "list"},
    {variable: "GATEWAY_HOST", path: ["gateway", "host"], parser: "text"},
    {variable: "GATEWAY_PORT", path: ["gateway", "port"], parser: "integer"},
    {variable: "GATEWAY_HEARTBEAT_INTERVAL", path: ["gateway", "heartbeatInterval"], parser: "integer"},
    {variable: "GATEWAY_IDENTIFY_TIMEOUT", path: ["gateway", "identifyTimeout"], parser: "integer"},
    {variable: "GATEWAY_RESUME_TIMEOUT", path: ["gateway", "resumeTimeout"], parser: "integer"},
    {variable: "GATEWAY_REPLAY_BUFFER_SIZE", path: ["gateway", "replayBufferSize"], parser: "integer"},
    {variable: "GATEWAY_MAX_PAYLOAD_SIZE", path: ["gateway", "maxPayloadSize"], parser: "integer"},
    {variable: "GATEWAY_RATE_LIMIT_MAX_MESSAGES", path: ["gateway", "rateLimit", "maxMessages"], parser: "integer"},
    {variable: "GATEWAY_RATE_LIMIT_WINDOW_MS", path: ["gateway", "rateLimit", "windowMs"], parser: "integer"},
    {variable: "GATEWAY_MAX_CONNECTIONS", path: ["gateway", "maxConnections"], parser: "integer"},
    {variable: "GATEWAY_MAX_CONNECTIONS_PER_IP", path: ["gateway", "maxConnectionsPerIp"], parser: "integer"},
    {variable: "GATEWAY_IPV6_PREFIX_LENGTH", path: ["gateway", "ipv6PrefixLength"], parser: "integer"},
    {variable: "GATEWAY_AUTH_FAILURE_LIMIT", path: ["gateway", "authFailure", "limit"], parser: "integer"},
    {variable: "GATEWAY_AUTH_FAILURE_WINDOW_MS", path: ["gateway", "authFailure", "windowMs"], parser: "integer"},
    {variable: "HEALTH_PUSH_URL", path: ["health", "pushUrl"], parser: "text", file: true},
    {variable: "HEALTH_PUSH_INTERVAL", path: ["health", "pushInterval"], parser: "integer"},
    {variable: "LOG_DEBUG", path: ["logging", "debug"], parser: "flag"},
    {variable: "TWITCH_WEBHOOK_CALLBACK_URL", path: ["twitch", "webhook", "callbackURL"], parser: "text", required: true},
    {variable: "TWITCH_WEBHOOK_SECRET", path: ["twitch", "webhook", "secretKey"], parser: "text", file: true, required: true},
];

type RawConfig = Record<string, unknown>;

/** Reads the configuration from the environment once at startup and validates it. */
@Bean()
export class ConfigManager {
    @Autowired()
    private logger!: Logger;

    private values!: ConfigValues;

    /** Loads and validates the configuration – an invalid one stops the startup. */
    @PostConstruct()
    public initialize(): void {
        this.values = ConfigManager.load();
        this.logger.info("SYSTEM", `Environment: ${this.values.environment}`);
    }

    /** The validated configuration. */
    public get(): ConfigValues {
        if (!this.values) throw new MainError("CONFIG_NOT_INITIALIZED", "The configuration has not been initialized yet");
        return this.values;
    }

    /** Reads and validates the environment without the bean container (also used by the healthcheck command). */
    public static load(): ConfigValues {
        const raw: RawConfig = {};
        const sources: Map<string, string> = ConfigManager.applyEnvironment(raw);

        const parsed: z.ZodSafeParseResult<ConfigValues> = configSchema.safeParse(raw);
        if (!parsed.success) {
            // Name the environment variable in every error, not the internal config path.
            const problems: string[] = parsed.error.issues.map((issue: z.core.$ZodIssue): string => {
                const path: string = issue.path.join(".");
                const variable: string | undefined = sources.get(path);
                if (variable) return `${variable}: ${issue.message}`;

                const candidates: string[] = envMappings
                    .filter((mapping: EnvMapping): boolean => mapping.path.join(".").startsWith(path))
                    .map((mapping: EnvMapping): string => mapping.variable);
                return `${path || "config"}${candidates.length > 0 ? ` (${candidates.join(", ")})` : ""}: ${issue.message}`;
            });
            throw new MainError("CONFIG_VALIDATION_ERROR", `The configuration is invalid – ${problems.join("; ")}`);
        }
        return parsed.data;
    }

    /** Copies every set variable into the raw config; returns which variable set which path. */
    private static applyEnvironment(raw: RawConfig): Map<string, string> {
        const sources: Map<string, string> = new Map<string, string>();
        const missing: string[] = [];
        const problems: string[] = [];

        for (const mapping of envMappings) {
            let value: string | undefined;
            let variable: string = mapping.variable;
            try {
                [value, variable] = ConfigManager.readVariable(mapping);
            } catch (error) {
                problems.push(error instanceof Error ? error.message : String(error));
                continue;
            }
            // Unset (and empty) variables keep the default.
            if (value === undefined) {
                if (mapping.required) missing.push(ConfigManager.describeMissing(mapping));
                continue;
            }

            const parsed: z.ZodSafeParseResult<unknown> = envParsers[mapping.parser].safeParse(value);
            if (!parsed.success) {
                // Never echo the content of a secret.
                const got: string = mapping.file ? "" : ` (got "${value}")`;
                problems.push(`${variable}: ${parsed.error.issues[0]?.message ?? "invalid value"}${got}`);
                continue;
            }

            ConfigManager.setPath(raw, mapping.path, parsed.data);
            sources.set(mapping.path.join("."), variable);
        }

        if (missing.length > 0) problems.unshift(`missing required variables: ${missing.join(", ")}`);
        if (problems.length > 0) throw new MainError("CONFIG_VALIDATION_ERROR", `Invalid environment variables – ${problems.join("; ")}`);
        return sources;
    }

    /** Name of a missing required variable for the error message. */
    private static describeMissing(mapping: EnvMapping): string {
        return mapping.file ? `${mapping.variable} (or ${mapping.variable}_FILE)` : mapping.variable;
    }

    /** Reads a variable or its <NAME>_FILE variant – setting both is an error. */
    private static readVariable(mapping: EnvMapping): [string | undefined, string] {
        const direct: string | undefined = process.env[mapping.variable] || undefined;
        if (!mapping.file) return [direct, mapping.variable];

        const fileVariable: string = `${mapping.variable}_FILE`;
        const filePath: string | undefined = process.env[fileVariable] || undefined;
        if (direct !== undefined && filePath !== undefined) {
            throw new Error(`${mapping.variable} and ${fileVariable} are both set, use only one of them`);
        }
        if (filePath === undefined) return [direct, mapping.variable];

        try {
            return [fs.readFileSync(filePath, "utf8").trim(), fileVariable];
        } catch (error) {
            throw new Error(`${fileVariable}: cannot read ${filePath} (${error instanceof Error ? error.message : String(error)})`);
        }
    }

    /** Sets a nested value, e.g. ["gateway", "rateLimit", "windowMs"]. */
    private static setPath(target: RawConfig, path: string[], value: unknown): void {
        let current: RawConfig = target;
        for (const key of path.slice(0, -1)) {
            const next: unknown = current[key];
            if (typeof next !== "object" || next === null || Array.isArray(next)) current[key] = {};
            current = current[key] as RawConfig;
        }
        current[path[path.length - 1]] = value;
    }
}
