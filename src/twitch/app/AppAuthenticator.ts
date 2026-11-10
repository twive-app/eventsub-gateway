import crypto from "node:crypto";
import type {RESTPostClientCredentialsGrantFlowTokenResponse} from "twitch-dev-types";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import type {TwitchClient} from "@twitch/TwitchClient.ts";
import type {AppStore, AppToken} from "@twitch/app/AppStore.ts";

/** A valid app access token and when it expires. */
export interface ClientCredentials {
    accessToken: string;
    expiresAt: number;
}

/** `invalid`: Twitch rejected id/secret; `unavailable`: Twitch couldn't be asked (network, timeout, 429, 5xx). */
export type AppCredentialsResult = {status: "valid"; credentials: ClientCredentials} | {status: "invalid"} | {status: "unavailable"};

const tokenRenewalWindowMs: number = 60 * 60 * 1000;

// Rejected secrets aren't sent to Twitch again for a minute – failed logins must not flood the token endpoint.
const rejectedSecretTtlMs: number = 60 * 1000;
const rejectedSecretCacheSize: number = 10000;
const rejectedStatuses: Set<number> = new Set<number>([400, 401, 403]);

/** Verifies client id + secret against Twitch and manages the app access tokens. */
@Bean()
export class AppAuthenticator {
    @Autowired()
    private twitchClient!: TwitchClient;

    @Autowired()
    private appStore!: AppStore;

    @Autowired()
    private logger!: Logger;

    @Autowired()
    private errorReporter!: ErrorReporter;

    /** Secret hash → time until which Twitch's rejection is reused, oldest first. Hashes only, never secrets. */
    private readonly rejectedSecrets: Map<string, number> = new Map<string, number>();

    /** Checks the client credentials (IDENTIFY and RESUME) and returns a valid app access token. */
    public async getCredentials(clientId: string, clientSecret: string): Promise<AppCredentialsResult> {
        const secretHash: string = this.hashSecret(clientId, clientSecret);

        const cached: AppToken | null = await this.appStore.getToken(clientId);
        // The cached token is reused only for the same secret and while it is valid for more than an hour.
        if (
            cached &&
            this.safeEqual(cached.secretHash, secretHash) &&
            cached.expiresAt - Date.now() > tokenRenewalWindowMs
        ) {
            return {status: "valid", credentials: {accessToken: cached.accessToken, expiresAt: cached.expiresAt}};
        }

        if (this.isRejectedSecret(secretHash)) {
            this.logger.debug("AUTH", `Credentials of application ${clientId} were rejected by Twitch recently, not asking again`);
            return {status: "invalid"};
        }

        let tokenResponse: RESTPostClientCredentialsGrantFlowTokenResponse;
        try {
            this.logger.debug("AUTH", `Requesting an app access token for application ${clientId}`);
            tokenResponse = await this.twitchClient.requestAppToken(clientId, clientSecret);
        } catch (error) {
            const status: number | null = HttpError.statusOf(error);
            if (status !== null && rejectedStatuses.has(status)) {
                this.rememberRejectedSecret(secretHash);
                this.logger.debug("AUTH", `Twitch rejected the credentials of application ${clientId} (${status})`);
                return {status: "invalid"};
            }

            this.errorReporter.handleThrottled("AUTH", `Could not get an app access token from Twitch for application ${clientId}`, error);
            return {status: "unavailable"};
        }

        if (!tokenResponse?.access_token) {
            this.logger.warning("AUTH", `Twitch returned no app access token for application ${clientId}`);
            return {status: "unavailable"};
        }

        const credentials: ClientCredentials = {
            accessToken: tokenResponse.access_token,
            expiresAt: Date.now() + tokenResponse.expires_in * 1000,
        };

        await this.appStore.saveToken(clientId, {
            secretHash,
            ...credentials,
        }, tokenResponse.expires_in);

        return {status: "valid", credentials};
    }

    /** The stored app access token for background work (grant events), or null if it expired. */
    public async getAppAccessToken(clientId: string): Promise<string | null> {
        let stored: AppToken | null;
        try {
            stored = await this.appStore.getToken(clientId);
        } catch (error) {
            this.logger.warning("AUTH", `Could not read the app access token of application ${clientId}`);
            this.errorReporter.handle(error, {clientId});
            return null;
        }

        if (!stored || stored.expiresAt <= Date.now()) {
            this.logger.warning("AUTH", `No valid app access token for application ${clientId}, it has to IDENTIFY again`);
            return null;
        }

        return stored.accessToken;
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

        // Maps iterate in insertion order: the first key is the oldest entry
        if (this.rejectedSecrets.size > rejectedSecretCacheSize) {
            const oldest: string | undefined = this.rejectedSecrets.keys().next().value;
            if (oldest !== undefined) this.rejectedSecrets.delete(oldest);
        }
    }

    /** sha256 of client id and secret – the secret itself is never stored. */
    private hashSecret(clientId: string, clientSecret: string): string {
        return crypto.createHash("sha256").update(`${clientId}:${clientSecret}`).digest("hex");
    }

    /** Constant-time comparison of two hashes. */
    private safeEqual(a: string, b: string): boolean {
        const bufferA: Buffer = Buffer.from(a);
        const bufferB: Buffer = Buffer.from(b);
        return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
    }
}
