import {beforeEach, describe, expect, test} from "bun:test";
import {HttpError} from "@core/http/HttpClient.ts";
import {AppAuthenticator, type AppCredentialsResult} from "@twitch/app/AppAuthenticator.ts";
import type {AppToken} from "@twitch/app/AppStore.ts";
import {provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

const clientId: string = "abc";
let tokens: Map<string, AppToken>;
let twitchCalls: number;
let twitchAnswer: () => Promise<{access_token: string; expires_in: number}>;
let authenticator: AppAuthenticator;

beforeEach((): void => {
    tokens = new Map<string, AppToken>();
    twitchCalls = 0;
    twitchAnswer = async (): Promise<{access_token: string; expires_in: number}> => ({access_token: "token-1", expires_in: 5000000});

    provideBean("configManager", new ConfigManagerMockup());
    provideBean("logger", new LoggerMockup());
    provideBean("appStore", {
        getToken: async (id: string): Promise<AppToken | null> => tokens.get(id) ?? null,
        saveToken: async (id: string, token: AppToken): Promise<void> => {
            tokens.set(id, token);
        },
    });
    provideBean("twitchClient", {
        requestAppToken: async (): Promise<{access_token: string; expires_in: number}> => {
            twitchCalls++;
            return await twitchAnswer();
        },
    });
    authenticator = new AppAuthenticator();
});

describe("AppAuthenticator.getCredentials", (): void => {
    test("asks Twitch once, then reuses the cached token for the same secret", async (): Promise<void> => {
        const first: AppCredentialsResult = await authenticator.getCredentials(clientId, "secret");
        const second: AppCredentialsResult = await authenticator.getCredentials(clientId, "secret");

        expect(first.status).toBe("valid");
        expect(second).toEqual(first);
        expect(twitchCalls).toBe(1);
    });

    test("stores only a hash of the secret", async (): Promise<void> => {
        await authenticator.getCredentials(clientId, "my-client-secret");
        const stored: string = JSON.stringify(tokens.get(clientId));

        expect(stored).not.toContain("my-client-secret");
        expect(tokens.get(clientId)?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("another secret doesn't get the cached token – Twitch decides", async (): Promise<void> => {
        await authenticator.getCredentials(clientId, "secret");
        twitchAnswer = async (): Promise<never> => {
            throw new HttpError(403, "POST", "https://id.twitch.tv/oauth2/token", {message: "invalid client secret"});
        };

        expect((await authenticator.getCredentials(clientId, "wrong")).status).toBe("invalid");
        expect(twitchCalls).toBe(2);
    });

    test("a rejected secret isn't sent to Twitch again right away", async (): Promise<void> => {
        twitchAnswer = async (): Promise<never> => {
            throw new HttpError(400, "POST", "https://id.twitch.tv/oauth2/token", {message: "invalid client"});
        };

        expect((await authenticator.getCredentials(clientId, "wrong")).status).toBe("invalid");
        expect((await authenticator.getCredentials(clientId, "wrong")).status).toBe("invalid");
        expect(twitchCalls).toBe(1);
    });

    test("a Twitch outage is 'unavailable', not 'invalid'", async (): Promise<void> => {
        twitchAnswer = async (): Promise<never> => {
            throw new HttpError(503, "POST", "https://id.twitch.tv/oauth2/token", "Service Unavailable");
        };
        expect((await authenticator.getCredentials(clientId, "secret")).status).toBe("unavailable");

        twitchAnswer = async (): Promise<never> => {
            throw new TypeError("fetch failed");
        };
        expect((await authenticator.getCredentials(clientId, "secret")).status).toBe("unavailable");
    });

    test("a token that expires within a day is renewed, one with more left is reused", async (): Promise<void> => {
        await authenticator.getCredentials(clientId, "secret");
        const cached: AppToken = tokens.get(clientId) as AppToken;

        tokens.set(clientId, {...cached, expiresAt: Date.now() + 25 * 60 * 60 * 1000});
        await authenticator.getCredentials(clientId, "secret");
        expect(twitchCalls).toBe(1);

        tokens.set(clientId, {...cached, expiresAt: Date.now() + 23 * 60 * 60 * 1000});
        await authenticator.getCredentials(clientId, "secret");
        expect(twitchCalls).toBe(2);
    });
});

describe("AppAuthenticator.needsRenewal", (): void => {
    test("no token or less than a day left – the same window getCredentials renews in", async (): Promise<void> => {
        expect(await authenticator.needsRenewal(clientId)).toBe(true);

        await authenticator.getCredentials(clientId, "secret");
        expect(await authenticator.needsRenewal(clientId)).toBe(false);

        tokens.set(clientId, {...(tokens.get(clientId) as AppToken), expiresAt: Date.now() + 23 * 60 * 60 * 1000});
        expect(await authenticator.needsRenewal(clientId)).toBe(true);
    });
});

describe("AppAuthenticator.getAppAccessToken", (): void => {
    test("the stored token while it is valid, otherwise null", async (): Promise<void> => {
        expect(await authenticator.getAppAccessToken(clientId)).toBeNull();

        await authenticator.getCredentials(clientId, "secret");
        expect(await authenticator.getAppAccessToken(clientId)).toBe("token-1");

        tokens.set(clientId, {...(tokens.get(clientId) as AppToken), expiresAt: Date.now() - 1});
        expect(await authenticator.getAppAccessToken(clientId)).toBeNull();
    });
});
