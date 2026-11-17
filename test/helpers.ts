import {BeanManager} from "@core/bean/BeanManager.ts";
import {ConfigManager, type ConfigValues} from "@core/config/ConfigManager.ts";

// Every variable the gateway reads starts with one of these – they are cleared so a local .env can't leak into a test.
const configPrefixes: string[] = ["ENVIRONMENT", "REDIS_", "SERVER_", "TRUSTED_PROXIES", "GATEWAY_", "HEALTH_", "LOG_", "TWITCH_"];

export const testWebhookSecret: string = "test-webhook-secret-123";
export const testCallbackUrl: string = "https://api.example.com/twitch/webhook/callback";

/** ConfigManager.load() with exactly the required variables plus `env` (undefined removes a variable). */
export function loadConfig(env: Record<string, string | undefined> = {}): ConfigValues {
    const saved: Record<string, string | undefined> = {...process.env};
    for (const key of Object.keys(process.env)) {
        if (configPrefixes.some((prefix: string): boolean => key.startsWith(prefix))) Reflect.deleteProperty(process.env, key);
    }

    const variables: Record<string, string | undefined> = {
        TWITCH_WEBHOOK_CALLBACK_URL: testCallbackUrl,
        TWITCH_WEBHOOK_SECRET: testWebhookSecret,
        ...env,
    };
    for (const [key, value] of Object.entries(variables)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
    }

    try {
        return ConfigManager.load();
    } finally {
        for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
        Object.assign(process.env, saved);
    }
}

/** Registers a stand-in under the token @Autowired resolves (the property name) – set it before creating the class. */
export function provideBean(token: string, bean: object): void {
    BeanManager.registerBean(token, bean);
}
