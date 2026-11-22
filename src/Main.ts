// Every bean file, in startup order – the order of the @PostConstructs. HttpServer comes last.
import "@core/config/ConfigManager";
import "@core/error/ErrorReporter";
import "@core/http/HttpClient";
import "@core/logging/Logger";
import "@core/metrics/MetricsRegistry";
import "@core/process/ProcessManager";
import "@core/proxy/ProxyService";
import "@core/redis/RedisClient";
import "@twitch/app/AppAuthenticator";
import "@twitch/app/AppAuthFailureLimiter";
import "@twitch/app/AppBotUserService";
import "@twitch/app/AppCleanupService";
import "@twitch/app/AppConduitCheckService";
import "@twitch/app/AppSetupService";
import "@twitch/app/AppStore";
import "@twitch/app/AppTokenRenewalService";
import "@twitch/eventsub/EventSubConduitManager";
import "@twitch/eventsub/EventSubLimitService";
import "@twitch/eventsub/EventSubMessageHandler";
import "@twitch/eventsub/EventSubPublicSubscriptionManager";
import "@twitch/eventsub/EventSubScopeService";
import "@twitch/eventsub/EventSubSubscriptionController";
import "@twitch/eventsub/EventSubSubscriptionManager";
import "@twitch/eventsub/EventSubUserSubscriptionManager";
import "@twitch/eventsub/EventSubWebhookController";
import "@twitch/eventsub/EventSubWebhookStore";
import "@twitch/TwitchClient";
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
import "@health/HealthMetricsController";
import "@core/http/HttpServer";

import {Autowired, MainClass} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import packageJson from "../package.json";

/** The gateway itself: creating it starts the bean lifecycle (index.ts imports this file only to start). */
@MainClass()
export class Main {
    @Autowired()
    private logger!: Logger;

    public constructor() {
        this.logger.header();
        this.logger.info("SYSTEM", "Starting", {
            version: packageJson.version || "unknown",
            bun: Bun.version,
        });
    }

    /** Called once every @PostConstruct finished. */
    public onStarted(): void {
        this.logger.info("SYSTEM", "Gateway is now running!");
    }
}
