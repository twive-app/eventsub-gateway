import {
    APIConduitShardStatus,
    type APIConduit,
    type APIConduitShard,
    type RESTGetConduitShardsResponse,
    type RESTGetConduitsResponse,
    type RESTPatchConduitShardsResponse,
    type RESTPostConduitsResponse,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App} from "@twitch/app/AppStore.ts";

/** The conduit of an application, whether it was just created and leftover conduits of ours (still at Twitch). */
export interface EventSubConduitResult {
    conduitId: string;
    created: boolean;
    // Taken over (their users and subscriptions), then deleted with removeOrphanedConduits() – see AppSetupService.
    orphanedConduitIds: string[];
}

/** Result of the regular conduit check: fine, shard enabled again, deleted at Twitch, or Twitch couldn't be asked. */
export type EventSubConduitCheck = "ok" | "repaired" | "gone" | "failed";

// A shard in one of these states delivers (pending: Twitch is verifying the callback we just set).
const workingShardStatuses: Set<string> = new Set<string>([
    APIConduitShardStatus.Enabled,
    APIConduitShardStatus.WebhookCallbackVerificationPending,
]);

/** Manages the one conduit per application: create, reuse, point its shard to the webhook, delete orphans and unused ones. */
@Bean()
export class EventSubConduitManager {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private twitchClient!: TwitchClient;

    // Per process: conduits whose shard was written since the start, apps already checked for orphans.
    private readonly verifiedConduits: Set<string> = new Set<string>();
    private readonly scannedApps: Set<string> = new Set<string>();
    // conduit id → shard repairs in a row that Twitch hasn't verified yet (the conduit check sees the outcome).
    private readonly unverifiedRepairs: Map<string, number> = new Map<string, number>();

    /** Makes sure the app has a working conduit of ours; null if Twitch can't be reached. */
    public async ensureConduit(app: App, accessToken: string): Promise<EventSubConduitResult | null> {
        const conduits: APIConduit[] | null = await this.getConduits(app, accessToken);
        if (!conduits) return null;

        let conduitId: string | null = app.conduitId ?? null;
        let created: boolean = false;

        // Deleted on Twitch (e.g. by the developer) – create a new one.
        if (conduitId && !conduits.some((conduit: APIConduit): boolean => conduit.id === conduitId)) {
            this.logger.warn("CONDUIT", "Gone at Twitch, creating a new one", {id: conduitId, app: app.clientId});
            this.verifiedConduits.delete(conduitId);
            conduitId = null;
        }

        if (!conduitId) {
            conduitId = await this.createConduit(app, accessToken);
            if (!conduitId) return null;
            created = true;
        }

        // Once per start and app (and after creating one): find leftover conduits of ours. They aren't deleted here –
        // after a Redis loss they are the only place that still knows the app's users.
        let orphanedConduitIds: string[] = [];
        if (created || !this.scannedApps.has(app.clientId)) {
            orphanedConduitIds = await this.findOrphanedConduits(app, accessToken, conduits, conduitId);
            if (orphanedConduitIds.length === 0) this.scannedApps.add(app.clientId);
        }

        // Write the shard once per start – this also re-enables a shard Twitch disabled.
        if (!this.verifiedConduits.has(conduitId)) {
            const updated: boolean = await this.updateShard(app, accessToken, conduitId);
            if (!updated) {
                // Don't leave an unusable new conduit behind (Twitch allows only 5 per client id).
                if (created) await this.deleteConduit(app, accessToken, conduitId);
                return null;
            }
            this.verifiedConduits.add(conduitId);
        }

        return {conduitId, created, orphanedConduitIds};
    }

    /** Deletes leftover conduits of ours once their users were taken over. */
    public async removeOrphanedConduits(app: App, accessToken: string, conduitIds: string[]): Promise<void> {
        for (const conduitId of conduitIds) {
            this.logger.info("CONDUIT", "Deleting an orphaned conduit of ours", {id: conduitId, app: app.clientId});
            this.verifiedConduits.delete(conduitId);
            await this.deleteConduit(app, accessToken, conduitId);
        }
        this.scannedApps.add(app.clientId);
    }

    /**
     * Checks the conduit at Twitch while the gateway runs: a shard Twitch disabled after delivery failures (or one that
     * points elsewhere) is set to our webhook again; "gone" if Twitch deleted the conduit.
     */
    public async checkConduit(app: App, accessToken: string, conduitId: string): Promise<EventSubConduitCheck> {
        let shards: APIConduitShard[];
        try {
            const response: RESTGetConduitShardsResponse = await this.twitchClient.getConduitShards(conduitId, {accessToken, clientId: app.clientId});
            shards = response.data;
        } catch (error) {
            if (HttpError.statusOf(error) === 404) {
                this.verifiedConduits.delete(conduitId);
                this.unverifiedRepairs.delete(conduitId);
                return "gone";
            }

            this.logger.warnThrottled("CONDUIT", "Could not check the conduit", {id: conduitId, app: app.clientId}, error);
            return "failed";
        }

        const shard: APIConduitShard | undefined = shards[0];
        const status: string = shard?.status ?? "missing";
        if (shard && workingShardStatuses.has(shard.status) && this.isOwnCallback(shard.transport.callback, app.clientId)) {
            // The last repair is verified – pending means Twitch is still at it.
            if (shard.status === APIConduitShardStatus.Enabled && this.unverifiedRepairs.delete(conduitId)) {
                this.logger.success("CONDUIT", "Shard verified by Twitch, delivers to the webhook again", {id: conduitId, app: app.clientId});
            }
            return "ok";
        }

        // Set again before and still not working: not a hiccup, Twitch can't verify the webhook.
        const repairs: number = this.unverifiedRepairs.get(conduitId) ?? 0;
        if (repairs > 0) {
            this.logger.error("CONDUIT", "Twitch can't verify the webhook – check TWITCH_WEBHOOK_SECRET and that TWITCH_WEBHOOK_CALLBACK_URL is reachable over HTTPS", {
                id: conduitId,
                app: app.clientId,
                status,
                attempts: repairs + 1,
            });
        } else {
            this.logger.warn("CONDUIT", "Shard doesn't deliver to us, pointing it to the webhook again", {id: conduitId, app: app.clientId, status});
        }

        if (!await this.updateShard(app, accessToken, conduitId)) return "failed";
        this.unverifiedRepairs.set(conduitId, repairs + 1);
        this.logger.info("CONDUIT", "Shard pointed to the webhook again, waiting for Twitch to verify it", {id: conduitId, app: app.clientId});
        return "repaired";
    }

    /** Deletes the conduit of an inactive app (its subscriptions go with it); false if Twitch failed. */
    public async removeConduit(app: App, accessToken: string, conduitId: string): Promise<boolean> {
        this.verifiedConduits.delete(conduitId);
        this.unverifiedRepairs.delete(conduitId);
        return await this.deleteConduit(app, accessToken, conduitId);
    }

    /** All conduits of the app; null if Twitch fails. */
    private async getConduits(app: App, accessToken: string): Promise<APIConduit[] | null> {
        try {
            const response: RESTGetConduitsResponse = await this.twitchClient.getConduits({accessToken, clientId: app.clientId});
            return response.data;
        } catch (error) {
            this.logger.error("CONDUIT", "Could not list the conduits", {app: app.clientId}, error);
            return null;
        }
    }

    /** Conduits whose shard points to our webhook but that aren't the app's conduit anymore. */
    private async findOrphanedConduits(app: App, accessToken: string, conduits: APIConduit[], conduitId: string): Promise<string[]> {
        const orphaned: string[] = [];
        for (const conduit of conduits) {
            if (conduit.id === conduitId) continue;

            let shards: APIConduitShard[];
            try {
                const response: RESTGetConduitShardsResponse = await this.twitchClient.getConduitShards(conduit.id, {accessToken, clientId: app.clientId});
                shards = response.data;
            } catch (error) {
                this.logger.warn("CONDUIT", "Could not check the shards", {id: conduit.id, app: app.clientId}, error);
                continue;
            }

            // Conduits with another callback belong to the developer – never touch them.
            if (shards.some((shard: APIConduitShard): boolean => this.isOwnCallback(shard.transport.callback, app.clientId))) orphaned.push(conduit.id);
        }
        return orphaned;
    }

    /** Whether a shard callback is our webhook URL for this app. */
    private isOwnCallback(callback: string | undefined, clientId: string): boolean {
        if (!callback || !URL.canParse(callback)) return false;

        const actual: URL = new URL(callback);
        const expected: URL = this.callbackUrl(clientId);
        return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.searchParams.get("client_id") === clientId;
    }

    /** Our webhook URL with ?client_id=<app>, so incoming events can be assigned to their app. */
    private callbackUrl(clientId: string): URL {
        const callback: URL = new URL(this.configManager.get().twitch.webhook.callbackURL);
        callback.searchParams.set("client_id", clientId);
        return callback;
    }

    /** Creates a conduit with one shard; null on failure. */
    private async createConduit(app: App, accessToken: string): Promise<string | null> {
        try {
            const response: RESTPostConduitsResponse = await this.twitchClient.createConduit({accessToken, clientId: app.clientId});

            const conduitId: string | undefined = response.data[0]?.id;
            if (!conduitId) return null;

            this.logger.success("CONDUIT", "Created", {id: conduitId, app: app.clientId});
            return conduitId;
        } catch (error) {
            this.logger.error("CONDUIT", "Could not create a conduit", {app: app.clientId}, error);
            return null;
        }
    }

    /** Deletes a conduit (already gone counts as deleted); a failure is only logged. */
    private async deleteConduit(app: App, accessToken: string, conduitId: string): Promise<boolean> {
        try {
            await this.twitchClient.deleteConduit(conduitId, {accessToken, clientId: app.clientId});
            return true;
        } catch (error) {
            if (HttpError.statusOf(error) === 404) return true;

            this.logger.warn("CONDUIT", "Could not delete, delete it manually", {id: conduitId, app: app.clientId}, error);
            return false;
        }
    }

    /** Points shard 0 of the conduit to our webhook with the webhook secret. */
    private async updateShard(app: App, accessToken: string, conduitId: string): Promise<boolean> {
        const secretKey: ConfigValues["twitch"]["webhook"]["secretKey"] = this.configManager.get().twitch.webhook.secretKey;
        const callback: URL = this.callbackUrl(app.clientId);

        try {
            const response: RESTPatchConduitShardsResponse = await this.twitchClient.updateConduitShard(
                conduitId,
                callback.toString(),
                secretKey,
                {accessToken, clientId: app.clientId},
            );

            if (response.errors && response.errors.length > 0) {
                this.logger.error("CONDUIT", "Twitch rejected the shard", {id: conduitId, app: app.clientId, reason: response.errors[0].message});
                return false;
            }

            return true;
        } catch (error) {
            this.logger.error("CONDUIT", "Could not point the shard to the webhook", {id: conduitId, app: app.clientId}, error);
            return false;
        }
    }
}
