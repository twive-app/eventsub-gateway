import crypto from "node:crypto";
import type {RESTPostClientCredentialsGrantFlowTokenResponse} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {AppStore, AppToken} from "@twitch/app/AppStore.ts";

/** A valid app access token and when it expires. */
export interface ClientCredentials {
    accessToken: string;
    expiresAt: number;
}

/** `invalid`: Twitch rejected id/secret; `unavailable`: Twitch couldn't be asked (network, timeout, 429, 5xx). */
export type AppCredentialsResult = {status: "valid"; credentials: ClientCredentials} | {status: "invalid"} | {status: "unavailable"};

// A token with less left is renewed on IDENTIFY/RESUME – AppTokenRenewalService asks the clients to RESUME in time.
const tokenRenewalWindowMs: number = 24 * 60 * 60 * 1000;

// Rejected secrets aren't sent to Twitch again for a minute – failed logins must not flood the token endpoint.
const rejectedSecretTtlMs: number = 60 * 1000;
const rejectedSecretCacheSize: number = 10000;
const rejectedStatuses: Set<number> = new Set<number>([400, 401, 403]);

/** Verifies client id + secret against Twitch and manages the app access tokens. */
@Bean()
export class AppAuthenticator {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private logger!: Logger;

    /** Secret hash → time until which Twitch's rejection is reused, oldest first. Hashes only, never secrets. */
    private readonly rejectedSecrets: Map<string, number> = new Map<string, number>();

    /**
     * Checks the client credentials (IDENTIFY, RESUME and /twitch/subscriptions) and returns a valid app access token.
     * Twitch is asked only for a new secret or a token that expires within a day.
     */
    public async getCredentials(clientId: string, clientSecret: string): Promise<AppCredentialsResult> {
        const secretHash: string = this.hashSecret(clientId, clientSecret);

        const stored: AppToken | null = await this.appStore.getToken(clientId);
        // The cached token belongs to this secret only if the hashes match.
        const cached: AppToken | null = stored && this.safeEqual(stored.secretHash, secretHash) ? stored : null;
        if (cached && cached.expiresAt - Date.now() > tokenRenewalWindowMs) return AppAuthenticator.valid(cached);

        if (this.isRejectedSecret(secretHash)) {
            this.logger.debug("AUTH", "Credentials rejected recently, not asking Twitch again", {
                app: clientId,
            });
            return {
                status: "invalid",
            };
        }

        let tokenResponse: RESTPostClientCredentialsGrantFlowTokenResponse;
        try {
            this.logger.debug("AUTH", "Requesting an app access token", {
                app: clientId,
            });
            tokenResponse = await this.twitchClient.requestAppToken(clientId, clientSecret);
        } catch (error) {
            const status: number | null = HttpError.statusOf(error);
            if (status !== null && rejectedStatuses.has(status)) {
                this.rememberRejectedSecret(secretHash);
                this.logger.debug("AUTH", "Twitch rejected the credentials", {
                    app: clientId, status,
                });
                return {
                    status: "invalid",
                };
            }

            this.logger.warnThrottled("AUTH", "Could not get an app access token from Twitch", {
                app: clientId,
            }, error);
            return this.fallBackToCache(clientId, cached);
        }

        if (!tokenResponse?.access_token) {
            this.logger.warn("AUTH", "Twitch returned no app access token", {
                app: clientId,
            });
            return this.fallBackToCache(clientId, cached);
        }

        const credentials: ClientCredentials = {
            accessToken: tokenResponse.access_token,
            expiresAt: Date.now() + tokenResponse.expires_in * 1000,
        };

        await this.appStore.saveToken(clientId, {
            secretHash,
            ...credentials,
        }, tokenResponse.expires_in);

        return {
            status: "valid",
            credentials,
        };
    }

    /**
     * Twitch couldn't renew the token: the cached one of this secret is used while it is valid (less than a day left) –
     * a Twitch outage must not stop clients whose token still works. Without one: unavailable.
     */
    private fallBackToCache(clientId: string, cached: AppToken | null): AppCredentialsResult {
        if (!cached || cached.expiresAt <= Date.now()) return {
            status: "unavailable",
        };

        this.logger.debug("AUTH", "Twitch unavailable, using the cached app access token", {
            app: clientId,
        });
        return AppAuthenticator.valid(cached);
    }

    /** The stored app access token for background work (grant events), or null if it expired – logged, the work is lost. */
    public async getAppAccessToken(clientId: string): Promise<string | null> {
        let accessToken: string | null;
        try {
            accessToken = await this.findAppAccessToken(clientId);
        } catch (error) {
            this.logger.warn("AUTH", "Could not read the app access token", {
                app: clientId,
            }, error);
            return null;
        }

        if (!accessToken) this.logger.warn("AUTH", "No valid app access token until the next IDENTIFY", {
            app: clientId,
        });
        return accessToken;
    }

    /** The stored app access token if it is still valid, without logging – for regular checks that skip an app without one. */
    public async findAppAccessToken(clientId: string): Promise<string | null> {
        const stored: AppToken | null = await this.appStore.getToken(clientId);
        return stored && stored.expiresAt > Date.now() ? stored.accessToken : null;
    }

    /** Whether the stored token is missing or expires within a day – the next IDENTIFY/RESUME then renews it. */
    public async needsRenewal(clientId: string): Promise<boolean> {
        const stored: AppToken | null = await this.appStore.getToken(clientId);
        return !stored || stored.expiresAt - Date.now() <= tokenRenewalWindowMs;
    }

    /** Whether Twitch rejected this secret within the last minute. */
    private isRejectedSecret(secretHash: string): boolean {
        const until: number | undefined = this.rejectedSecrets.get(secretHash);
        if (until === undefined) return false;
        if (until > Date.now()) return true;

        this.rejectedSecrets.delete(secretHash);
        return false;
    }

    /** Remembers a rejected secret; the cache drops its oldest entry when it is full. */
    private rememberRejectedSecret(secretHash: string): void {
        this.rejectedSecrets.delete(secretHash);
        this.rejectedSecrets.set(secretHash, Date.now() + rejectedSecretTtlMs);

        // Maps iterate in insertion order: the first key is the oldest entry.
        if (this.rejectedSecrets.size > rejectedSecretCacheSize) {
            const oldest: string | undefined = this.rejectedSecrets.keys().next().value;
            if (oldest !== undefined) this.rejectedSecrets.delete(oldest);
        }
    }

    /** HMAC of client id and secret – the secret itself is never stored. */
    private hashSecret(clientId: string, clientSecret: string): string {
        // Keyed with the webhook secret: a hash read from Redis alone can't be used to test guessed secrets.
        return crypto.createHmac("sha256", this.configManager.get().twitch.webhook.secretKey).update(`${clientId}:${clientSecret}`).digest("hex");
    }

    /** A cached token as the result of getCredentials(). */
    private static valid(token: AppToken): AppCredentialsResult {
        return {
            status: "valid",
            credentials: {
                accessToken: token.accessToken,
                expiresAt: token.expiresAt,
            },
        };
    }

    /** Constant-time comparison of two hashes. */
    private safeEqual(a: string, b: string): boolean {
        const bufferA: Buffer = Buffer.from(a);
        const bufferB: Buffer = Buffer.from(b);
        return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
    }
}
