import {beforeEach, describe, expect, test} from "bun:test";
import {AppTokenRenewalService} from "@twitch/app/AppTokenRenewalService.ts";
import {provideBean} from "../../../helpers.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

let expiring: Set<string>;
let withSessions: Set<string>;
let reconnected: string[];
let logger: LoggerMockup;

beforeEach((): void => {
    expiring = new Set<string>();
    withSessions = new Set<string>();
    reconnected = [];
    logger = new LoggerMockup();

    provideBean("logger", logger);
    provideBean("appStore", {getClientIds: async (): Promise<string[]> => ["a", "b", "c"]});
    provideBean("appAuthenticator", {needsRenewal: async (clientId: string): Promise<boolean> => expiring.has(clientId)});
    provideBean("sessionStore", {hasSessions: async (clientId: string): Promise<boolean> => withSessions.has(clientId)});
    provideBean("connectionRegistry", {
        reconnectApp: (clientId: string): number => {
            reconnected.push(clientId);
            return 1;
        },
    });
});

describe("AppTokenRenewalService", (): void => {
    test("only apps with an expiring token and a session get RECONNECT", async (): Promise<void> => {
        expiring = new Set<string>(["a", "b"]);
        withSessions = new Set<string>(["a", "c"]);

        await new AppTokenRenewalService().renewExpiringTokens();

        expect(reconnected).toEqual(["a"]);
        expect(logger.messages("info")).toEqual(["App access token expires soon, clients asked to RESUME"]);
    });

    test("a failing app doesn't stop the others", async (): Promise<void> => {
        expiring = new Set<string>(["a", "b"]);
        withSessions = new Set<string>(["a", "b"]);
        provideBean("appAuthenticator", {
            needsRenewal: async (clientId: string): Promise<boolean> => {
                if (clientId === "a") throw new Error("Redis down");
                return expiring.has(clientId);
            },
        });

        await new AppTokenRenewalService().renewExpiringTokens();

        expect(reconnected).toEqual(["b"]);
    });
});
