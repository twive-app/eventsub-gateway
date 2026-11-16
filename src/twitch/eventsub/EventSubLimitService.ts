import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {LogFields, Logger} from "@core/logging/Logger.ts";
import type {TwitchClient, TwitchSubscriptionUsage} from "@twitch/TwitchClient.ts";
import type {AppStore, AppToken} from "@twitch/app/AppStore.ts";

// From this share of max_total_cost on, an app counts as close to its limit.
const warningRatio: number = 0.8;

/** How close an application is to Twitch's subscription limit. */
type LimitLevel = "ok" | "warning" | "reached";

/** Last known subscription usage of an application. */
interface UsageEntry {
    usage: TwitchSubscriptionUsage;
    level: LimitLevel;
}

/** Keeps an eye on Twitch's subscription limit (max_total_cost) per application: logs and /health. */
@Bean()
export class EventSubLimitService {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private logger!: Logger;

    // In memory only – the hourly refresh fills it again after a restart.
    private readonly usages: Map<string, UsageEntry> = new Map<string, UsageEntry>();

    /** Records the usage Twitch reported (create or list response) and logs when the level changes. */
    public record(clientId: string, usage: TwitchSubscriptionUsage): void {
        const level: LimitLevel = EventSubLimitService.levelOf(usage);
        const previous: LimitLevel = this.usages.get(clientId)?.level ?? "ok";
        this.usages.set(clientId, {usage, level});

        if (level === previous) return;

        const fields: LogFields = {app: clientId, cost: `${usage.total_cost}/${usage.max_total_cost}`, subscriptions: usage.total};

        if (level === "reached") this.logger.error("EVENTSUB", "Subscription limit reached, new subscriptions fail", fields);
        else if (level === "warning") this.logger.warn("EVENTSUB", "Subscription limit almost reached (≥ 80 %)", fields);
        else this.logger.info("EVENTSUB", "Below the subscription limit again", fields);
    }

    /** Number of applications at or close to their limit, for /health. */
    public countNearLimit(): number {
        let count: number = 0;
        for (const entry of this.usages.values()) {
            if (entry.level !== "ok") count++;
        }
        return count;
    }

    /** Forgets an application (removed from Redis). */
    public forget(clientId: string): void {
        this.usages.delete(clientId);
    }

    /** Hourly (half past, apart from the cleanup): asks Twitch for the usage of every app with a valid token. */
    @Cron("0 30 * * * *")
    public async refreshUsages(): Promise<void> {
        for (const clientId of await this.appStore.getClientIds()) {
            try {
                // Silently skipped without a token – an inactive app has nothing to watch.
                const token: AppToken | null = await this.appStore.getToken(clientId);
                if (!token || token.expiresAt <= Date.now()) {
                    this.usages.delete(clientId);
                    continue;
                }

                this.record(clientId, await this.twitchClient.getSubscriptionUsage({accessToken: token.accessToken, clientId}));
            } catch (error) {
                this.logger.warnThrottled("EVENTSUB", "Could not check the subscription limit", {app: clientId}, error);
            }
        }
    }

    /** ok, warning (≥ 80 %) or reached (100 %). */
    private static levelOf(usage: TwitchSubscriptionUsage): LimitLevel {
        if (usage.max_total_cost <= 0) return "ok";
        if (usage.total_cost >= usage.max_total_cost) return "reached";
        return usage.total_cost >= usage.max_total_cost * warningRatio ? "warning" : "ok";
    }
}
