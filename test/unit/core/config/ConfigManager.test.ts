import {afterAll, describe, expect, test} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {ConfigValues} from "@core/config/ConfigManager.ts";
import {type EnvMapping, envMappings} from "@core/config/EnvMapping.ts";
import {loadConfig, testWebhookSecret} from "../../../helpers.ts";

const directory: string = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-config-"));

afterAll((): void => {
    fs.rmSync(directory, {recursive: true, force: true});
});

/** The message of the error ConfigManager.load() throws for these variables. */
function loadError(env: Record<string, string | undefined>): string {
    try {
        loadConfig(env);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error("the configuration was accepted");
}

describe("ConfigManager.load", (): void => {
    test("only the two webhook variables are required, everything else has a default", (): void => {
        const config: ConfigValues = loadConfig();

        expect(config.twitch.webhook.secretKey).toBe(testWebhookSecret);
        expect(config.server.port).toBe(3000);
        expect(config.gateway.port).toBe(3001);
        expect(config.gateway.host).toBe(config.server.host);
        expect(config.redis.keyPrefix).toBe("");
        expect(config.server.trustedProxies).toEqual([]);
    });

    test("names every missing required variable", (): void => {
        const message: string = loadError({TWITCH_WEBHOOK_CALLBACK_URL: undefined, TWITCH_WEBHOOK_SECRET: undefined});
        expect(message).toContain("TWITCH_WEBHOOK_CALLBACK_URL");
        expect(message).toContain("TWITCH_WEBHOOK_SECRET (or TWITCH_WEBHOOK_SECRET_FILE)");
    });

    test("an empty variable counts as unset", (): void => {
        expect(loadConfig({SERVER_PORT: ""}).server.port).toBe(3000);
    });

    test("parses integers, flags and lists", (): void => {
        const config: ConfigValues = loadConfig({SERVER_PORT: "8080", LOG_DEBUG: "yes", TRUSTED_PROXIES: "127.0.0.1, 172.16.0.0/12"});

        expect(config.server.port).toBe(8080);
        expect(config.logging.debug).toBe(true);
        expect(config.server.trustedProxies).toEqual(["127.0.0.1", "172.16.0.0/12"]);
    });

    test.each([
        ["SERVER_PORT", "abc"],
        ["SERVER_PORT", "70000"],
        ["TRUSTED_PROXIES", "not-an-ip"],
        ["REDIS_KEY_PREFIX", "twive:"],
        ["REDIS_KEY_PREFIX", "two words"],
        ["TWITCH_WEBHOOK_CALLBACK_URL", "no url"],
    ])("rejects %s=%s and names the variable", (variable: string, value: string): void => {
        expect(loadError({[variable]: value})).toContain(variable);
    });

    test("every variable of .env.example has a mapping and the other way round", (): void => {
        // <NAME>_FILE variants are read through the mapping of <NAME>, TZ by the runtime.
        const documented: string[] = [...fs.readFileSync(".env.example", "utf8").matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)]
            .map((match: RegExpExecArray): string => match[1])
            .filter((variable: string): boolean => !variable.endsWith("_FILE") && variable !== "TZ");
        const mapped: string[] = envMappings.map((mapping: EnvMapping): string => mapping.variable);

        expect([...new Set<string>(documented)].sort()).toEqual([...mapped].sort());
    });

    test("the nested options are set through their variables", (): void => {
        const config: ConfigValues = loadConfig({
            GATEWAY_RATE_LIMIT_MAX_MESSAGES: "3",
            GATEWAY_RATE_LIMIT_WINDOW_MS: "5000",
            GATEWAY_IPV6_PREFIX_LENGTH: "56",
            GATEWAY_AUTH_FAILURE_LIMIT: "4",
        });

        expect(config.gateway.rateLimit).toEqual({
            maxMessages: 3,
            windowMs: 5000,
        });
        expect(config.gateway.ipv6PrefixLength).toBe(56);
        expect(config.gateway.authFailure.limit).toBe(4);
    });

    test("the retention period may not be shorter than the inactivity period", (): void => {
        expect(loadError({GATEWAY_INACTIVE_APP_DAYS: "30", GATEWAY_APP_RETENTION_DAYS: "10"})).toContain("GATEWAY_APP_RETENTION_DAYS");
        expect(loadConfig({GATEWAY_INACTIVE_APP_DAYS: "30", GATEWAY_APP_RETENTION_DAYS: "0"}).gateway.appRetentionDays).toBe(0);
    });

    describe("secrets from files", (): void => {
        test("reads <NAME>_FILE and trims the line break", (): void => {
            const file: string = path.join(directory, "secret");
            fs.writeFileSync(file, "secret-from-a-file\n");

            const config: ConfigValues = loadConfig({TWITCH_WEBHOOK_SECRET: undefined, TWITCH_WEBHOOK_SECRET_FILE: file});
            expect(config.twitch.webhook.secretKey).toBe("secret-from-a-file");
        });

        test("<NAME> and <NAME>_FILE together are an error", (): void => {
            expect(loadError({TWITCH_WEBHOOK_SECRET_FILE: path.join(directory, "secret")})).toContain("are both set");
        });

        test("a missing file is an error", (): void => {
            expect(loadError({TWITCH_WEBHOOK_SECRET: undefined, TWITCH_WEBHOOK_SECRET_FILE: path.join(directory, "missing")})).toContain("cannot read");
        });

        test("an invalid secret is never echoed in the error", (): void => {
            const message: string = loadError({TWITCH_WEBHOOK_SECRET: "short-1"});
            expect(message).toContain("TWITCH_WEBHOOK_SECRET");
            expect(message).not.toContain("short-1");
        });
    });
});
