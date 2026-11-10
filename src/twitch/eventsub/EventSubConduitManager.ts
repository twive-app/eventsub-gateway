import type {
    APIConduit,
    APIConduitShard,
    RESTGetConduitShardsResponse,
    RESTGetConduitsResponse,
    RESTPatchConduitShardsResponse,
    RESTPostConduitsResponse,
} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {App} from "@twitch/app/AppStore.ts";

/** The conduit of an application and whether it was just created. */
export interface EventSubConduitResult {
    conduitId: string;
    created: boolean;
}

/** Manages the one conduit per application: create, reuse, point its shard to the webhook, delete orphans. */
@Bean()
export class EventSubConduitManager {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    @Autowired()
    private twitchClient!: TwitchClient;

    // Per process: conduits whose shard was written since the start, apps already checked for orphans.
    private readonly verifiedConduits: Set<string> = new Set<string>();
    private readonly scannedApps: Set<string> = new Set<string>();

    /** Makes sure the app has a working conduit of ours; null if Twitch can't be reached. */
    public async ensureConduit(app: App, accessToken: string): Promise<EventSubConduitResult | null> {
        const conduits: APIConduit[] | null = await this.getConduits(app, accessToken);
        if (!conduits) return null;

        let conduitId: string | null = app.conduitId ?? null;
        let created: boolean = false;

        // Deleted on Twitch (e.g. by the developer) – create a new one.
        if (conduitId && !conduits.some((conduit: APIConduit): boolean => conduit.id === conduitId)) {
            this.logger.warning("CONDUIT", `Conduit ${conduitId} of application ${app.clientId} no longer exists`);
            this.verifiedConduits.delete(conduitId);
            conduitId = null;
        }

        if (!conduitId) {
            conduitId = await this.createConduit(app, accessToken);
            if (!conduitId) return null;
            created = true;
        }

        // Once per start and app (and after creating one): remove leftover conduits of ours.
        if (created || !this.scannedApps.has(app.clientId)) {
            await this.deleteOrphanedConduits(app, accessToken, conduits, conduitId);
            this.scannedApps.add(app.clientId);
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

        return {conduitId, created};
    }

    /** All conduits of the app; null if Twitch fails. */
    private async getConduits(app: App, accessToken: string): Promise<APIConduit[] | null> {
        try {
            const response: RESTGetConduitsResponse = await this.twitchClient.getConduits({accessToken, clientId: app.clientId});
            return response.data;
        } catch (error) {
            this.logger.error("CONDUIT", `Failed fetching conduits for application with client id ${app.clientId}`);
            this.errorReporter.handle(error, {clientId: app.clientId});
            return null;
        }
    }

    /** Deletes conduits whose shard points to our webhook but that aren't the app's conduit any more. */
    private async deleteOrphanedConduits(app: App, accessToken: string, conduits: APIConduit[], conduitId: string): Promise<void> {
        for (const conduit of conduits) {
            if (conduit.id === conduitId) continue;

            let shards: APIConduitShard[];
            try {
                const response: RESTGetConduitShardsResponse = await this.twitchClient.getConduitShards(conduit.id, {accessToken, clientId: app.clientId});
                shards = response.data;
            } catch (error) {
                this.logger.warning("CONDUIT", `Could not check the shards of conduit ${conduit.id} of application ${app.clientId}`);
                this.errorReporter.handle(error, {clientId: app.clientId, conduitId: conduit.id});
                continue;
            }

            // Conduits with another callback belong to the developer – never touch them.
            if (!shards.some((shard: APIConduitShard): boolean => this.isOwnCallback(shard.transport.callback, app.clientId))) continue;

            this.logger.warning("CONDUIT", `Deleting orphaned conduit ${conduit.id} of application ${app.clientId} (its shard points to our webhook)`);
            await this.deleteConduit(app, accessToken, conduit.id);
        }
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

            this.logger.success("CONDUIT", `Created EventSub conduit ${conduitId} for application with client id ${app.clientId}`);
            return conduitId;
        } catch (error) {
            this.logger.error("CONDUIT", `Failed creating EventSub conduit for application with client id ${app.clientId}`);
            this.errorReporter.handle(error, {clientId: app.clientId});
            return null;
        }
    }

    /** Deletes a conduit; a failure is only logged. */
    private async deleteConduit(app: App, accessToken: string, conduitId: string): Promise<void> {
        try {
            await this.twitchClient.deleteConduit(conduitId, {accessToken, clientId: app.clientId});
        } catch (error) {
            this.logger.warning("CONDUIT", `Could not delete conduit ${conduitId} of application ${app.clientId}, delete it manually`);
            this.errorReporter.handle(error, {clientId: app.clientId, conduitId});
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
                this.logger.error("CONDUIT", `Failed updating shard of conduit ${conduitId}: ${response.errors[0].message}`);
                return false;
            }

            return true;
        } catch (error) {
            this.logger.error("CONDUIT", `Failed updating EventSub conduit shard for application with client id ${app.clientId}`);
            this.errorReporter.handle(error, {clientId: app.clientId, conduitId});
            return false;
        }
    }
}
