import type {RESTGetUsersResponse} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";

/** Bot user after IDENTIFY and whether it changed. */
export interface BotUserUpdate {
    botUserId: string | null;
    changed: boolean;
}

// Bot changes within this window count as flapping (several clients with different bots).
const botUserFlappingWindowMs: number = 5 * 60 * 1000;

/** The bot user of an application (botUserId of IDENTIFY): checks it at Twitch, stores it and warns if it keeps changing. */
@Bean()
export class AppBotUserService {
    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private logger!: Logger;

    private readonly botUserChanges: Map<string, number[]> = new Map<string, number[]>();
    private readonly botUserWarnings: Map<string, number> = new Map<string, number>();

    /** botUserId of IDENTIFY: undefined keeps the bot, null removes it, a new id is checked (null = unknown). */
    public async updateBotUser(clientId: string, botUserId: string | null | undefined, accessToken: string): Promise<BotUserUpdate | null> {
        const app: App = await this.appStore.findOrCreate(clientId);
        if (botUserId === undefined || botUserId === app.botUserId) return {
            botUserId: app.botUserId,
            changed: false,
        };
        if (botUserId !== null && !await this.botUserExists(clientId, botUserId, accessToken)) return null;

        const updated: App | null = await this.appStore.update(clientId, {
            botUserId,
        });
        if (!updated) return {
            botUserId: app.botUserId,
            changed: false,
        };

        this.logger.info("APP", "Bot user changed", {
            id: clientId,
            from: app.botUserId ?? "none",
            to: botUserId ?? "none",
        });
        this.warnOnFlappingBotUser(clientId, botUserId);
        return {
            botUserId,
            changed: true,
        };
    }

    /** Warns once per window if the bot of an app keeps changing. */
    private warnOnFlappingBotUser(clientId: string, botUserId: string | null): void {
        const now: number = Date.now();
        const changes: number[] = (this.botUserChanges.get(clientId) ?? []).filter((at: number): boolean => now - at < botUserFlappingWindowMs);
        changes.push(now);
        this.botUserChanges.set(clientId, changes);

        if (changes.length < 2 || now - (this.botUserWarnings.get(clientId) ?? 0) < botUserFlappingWindowMs) return;

        this.botUserWarnings.set(clientId, now);
        this.logger.warn("APP", "Bot user keeps changing – clients with different botUserIds?", {
            id: clientId,
            changes: changes.length,
            within: "5m",
            now: botUserId ?? "none",
        });
    }

    /** Whether the bot user exists – a Helix failure doesn't block IDENTIFY, only a clear "no" does. */
    private async botUserExists(clientId: string, botUserId: string, accessToken: string): Promise<boolean> {
        try {
            const response: RESTGetUsersResponse = await this.twitchClient.getUsersById([botUserId], {
                accessToken,
                clientId,
            });
            return response.data.length > 0;
        } catch (error) {
            if (HttpError.statusOf(error) === 400) return false;

            this.logger.warn("APP", "Could not verify the bot user, storing it unverified", {
                id: clientId,
                botUser: botUserId,
            }, error);
            return true;
        }
    }
}
