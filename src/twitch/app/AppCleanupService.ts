import {Autowired, Bean, Cron} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";
import type {AppAuthenticator} from "@twitch/app/AppAuthenticator.ts";
import type {App, AppStore} from "@twitch/app/AppStore.ts";
import type {EventSubConduitManager} from "@twitch/eventsub/EventSubConduitManager.ts";

const dayMs: number = 24 * 60 * 60 * 1000;

/**
 * Cleans up apps without a client: after GATEWAY_INACTIVE_APP_DAYS their conduit is deleted (Twitch stops sending
 * events), after GATEWAY_APP_RETENTION_DAYS the whole app is removed from Redis.
 */
@Bean()
export class AppCleanupService {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private sessionStore!: SessionStore;

    @Autowired()
    private appAuthenticator!: AppAuthenticator;

    @Autowired()
    private eventSubConduitManager!: EventSubConduitManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    /** Hourly: apps with a session count as active, the others are deactivated or removed once inactive too long. */
    @Cron("0 0 * * * *")
    public async cleanUpInactiveApps(): Promise<void> {
        const {inactiveAppDays, appRetentionDays}: ConfigValues["gateway"] = this.configManager.get().gateway;
        if (inactiveAppDays === 0 && appRetentionDays === 0) return;

        for (const clientId of await this.appStore.getClientIds()) {
            try {
                await this.checkApp(clientId, inactiveAppDays, appRetentionDays);
            } catch (error) {
                this.logger.error("CONDUIT", `Failed checking whether application ${clientId} is inactive`);
                this.errorReporter.handle(error, {clientId});
            }
        }
    }

    /** One app: refresh its activity while it has a session, otherwise remove or deactivate it after its cutoff. */
    private async checkApp(clientId: string, inactiveAppDays: number, appRetentionDays: number): Promise<void> {
        const app: App | null = await this.appStore.find(clientId);
        if (!app) return;

        // A connection that lasts for weeks never IDENTIFYs again – its session keeps the app active.
        if (await this.sessionStore.hasSessions(clientId)) {
            await this.appStore.markActive(clientId);
            return;
        }

        const lastActiveAt: number = app.lastActiveAt ?? app.updatedAt;
        const now: number = Date.now();

        if (appRetentionDays > 0 && lastActiveAt <= now - appRetentionDays * dayMs) {
            await this.removeApp(app, now - appRetentionDays * dayMs, appRetentionDays);
        } else if (inactiveAppDays > 0 && app.conduitId && lastActiveAt <= now - inactiveAppDays * dayMs) {
            await this.deactivateApp(app, now - inactiveAppDays * dayMs, inactiveAppDays);
        }
    }

    /** Forgets the conduit, then deletes it at Twitch – the authorized users stay for the next IDENTIFY. */
    private async deactivateApp(app: App, cutoff: number, days: number): Promise<void> {
        // Forget the conduit first: an IDENTIFY from now on sets up a new one instead of using this one.
        const conduitId: string | null = await this.appStore.deactivate(app.clientId, cutoff);
        if (!conduitId) return;

        const deleted: boolean = await this.deleteConduit(app, conduitId, await this.appAuthenticator.getAppAccessToken(app.clientId));
        this.logger.info("CONDUIT", `Application ${app.clientId} had no client for ${days} days, `
            + (deleted ? `deleted its conduit ${conduitId}` : `its conduit ${conduitId} is left to expire at Twitch`)
            + " – the next IDENTIFY sets it up again");
    }

    /** Removes the app with its token and users from Redis and deletes a conduit it still has. */
    private async removeApp(app: App, cutoff: number, days: number): Promise<void> {
        // The token is removed together with the app – read it before.
        const accessToken: string | null = app.conduitId ? await this.appAuthenticator.getAppAccessToken(app.clientId) : null;

        const removed: App | null = await this.appStore.removeInactive(app.clientId, cutoff);
        if (!removed) return;

        const deleted: boolean = removed.conduitId ? await this.deleteConduit(removed, removed.conduitId, accessToken) : true;
        this.logger.info("CONDUIT", `Application ${app.clientId} had no client for ${days} days, removed it`
            + (deleted ? "" : ` – its conduit ${removed.conduitId ?? ""} is left to expire at Twitch`)
            + " – the next IDENTIFY starts from scratch, its users have to authorize it again");
    }

    /** Deletes a conduit at Twitch; without a token the webhook refuses its events (see EventSubWebhookController). */
    private async deleteConduit(app: App, conduitId: string, accessToken: string | null): Promise<boolean> {
        if (!accessToken) return false;
        return await this.eventSubConduitManager.removeConduit(app, accessToken, conduitId);
    }
}
