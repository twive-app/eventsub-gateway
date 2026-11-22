import fs from "node:fs";
import type z from "zod";
import {Autowired, Bean, PostConstruct} from "@core/bean/BeanDecorators.ts";
import {configSchema} from "@core/config/ConfigSchema.ts";
import {type EnvMapping, envMappings, envParsers} from "@core/config/EnvMapping.ts";
import {MainError} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";

export type ConfigValues = z.infer<typeof configSchema>;

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
        this.logger.info("SYSTEM", "Configuration loaded", {
            environment: this.values.environment,
        });
    }

    /** Whether the configuration was loaded – false while starting and after an invalid one. */
    public isLoaded(): boolean {
        return this.values !== undefined;
    }

    /** The validated configuration. */
    public get(): ConfigValues {
        if (!this.values) throw new MainError("CONFIG_NOT_INITIALIZED", "The configuration has not been initialized yet");
        return this.values;
    }

    /** Reads and validates the environment – static, so the tests can load a configuration without the bean container. */
    public static load(): ConfigValues {
        const raw: RawConfig = {};
        const sources: Map<string, string> = ConfigManager.applyEnvironment(raw);

        const parsed: z.ZodSafeParseResult<ConfigValues> = configSchema.safeParse(raw);
        if (!parsed.success) {
            // Name the environment variable in every error, not the internal config path.
            const problems: string[] = parsed.error.issues.map((issue: z.core.$ZodIssue): string => {
                const path: string = issue.path.join(".");
                // A list entry (e.g. server.trustedProxies.0) belongs to the variable of the whole list.
                const variable: string | undefined = issue.path
                    .map((_segment: PropertyKey, index: number): string | undefined =>
                        sources.get(issue.path.slice(0, issue.path.length - index).join(".")),
                    ).find((candidate: string | undefined): boolean => candidate !== undefined);
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
