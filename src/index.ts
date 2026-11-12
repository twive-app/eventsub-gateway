// Every bean file, in startup order – the order of the @PostConstructs. HttpServer comes last.
import "@core/config/ConfigManager";
import "@core/error/ErrorReporter";
import "@core/http/HttpClient";
import "@core/http/HttpProxyService";
import "@core/logging/Logger";
import "@core/process/ProcessManager";
import "@core/redis/RedisClient.ts";
import "@twitch/app/AppAuthenticator";
import "@twitch/app/AppCleanupService";
import "@twitch/app/AppSetupService";
import "@twitch/app/AppStore";
import "@twitch/eventsub/EventSubConduitManager";
import "@twitch/eventsub/EventSubMessageHandler";
import "@twitch/eventsub/EventSubScopeService";
import "@twitch/eventsub/EventSubSubscriptionManager";
import "@twitch/eventsub/EventSubWebhookController";
import "@twitch/eventsub/EventSubWebhookStore";
import "@twitch/TwitchClient.ts";
import "@gateway/connection/ConnectionLimitManager";
import "@gateway/connection/ConnectionRegistry";
import "@gateway/connection/ConnectionStore";
import "@gateway/session/SessionDispatcher";
import "@gateway/session/SessionStore";
import "@gateway/GatewayHandler";
import "@gateway/GatewayServer";
import "@health/HealthCheckService";
import "@health/HealthPushService";
import "@health/HealthController";
import "@core/http/HttpServer";

import {Autowired, MainClass} from "@core/bean/BeanDecorators.ts";
import {ConfigManager, type ConfigValues} from "@core/config/ConfigManager.ts";
import type {Logger} from "@core/logging/Logger.ts";
import packageJson from "../package.json";

/** `gateway health check`: asks GET /health of the running gateway, exit code 0 = healthy (Docker HEALTHCHECK). */
async function runHealthcheck(): Promise<number> {
    try {
        const {host, port}: ConfigValues["server"] = ConfigManager.load().server;
        // A wildcard bind address isn't reachable as a target, use loopback.
        const target: string = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
        const response: Response = await fetch(`http://${target}:${port}/health`, {signal: AbortSignal.timeout(3000)});
        if (response.status === 200) return 0;

        console.error(`GET /health answered ${response.status}`);
    } catch (error) {
        console.error(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
}

// CLI commands run without starting the gateway.
const command: string | undefined = process.argv[2];

if (command === "healthcheck") process.exit(await runHealthcheck());

if (command === "--version") {
    console.log(packageJson.version);
    process.exit(0);
}

if (command !== undefined) {
    console.error(`Unknown command ${command}. Usage: gateway [healthcheck | --version]`);
    process.exit(1);
}

@MainClass()
export class Main {
    @Autowired()
    private logger!: Logger;

    public constructor() {
        this.logger.header();
        this.logger.info("SYSTEM", "Starting process...");
        this.logger.info("SYSTEM", `Gateway version: ${packageJson.version || "unknown"}`);
        this.logger.info("SYSTEM", `Bun version: ${Bun.version}`);
    }

    /** Called once every @PostConstruct finished. */
    public onStarted(): void {
        this.logger.success("SYSTEM", "Gateway is now running!");
    }
}
