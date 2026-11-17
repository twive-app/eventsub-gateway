import {afterEach, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import type {App} from "@twitch/app/AppStore.ts";
import {GatewayMockup} from "../mockups/GatewayMockup.ts";

const clientId: string = "gp762nuuoqcoxypju8c569th9wz7q5";
const secret: string = "client-secret";
const day: number = 24 * 60 * 60 * 1000;
let gateway: GatewayMockup;

beforeEach(async (): Promise<void> => {
    setSystemTime(new Date("2026-11-01T12:00:00Z"));
    gateway = new GatewayMockup({GATEWAY_INACTIVE_APP_DAYS: "30", GATEWAY_APP_RETENTION_DAYS: "0"});
    gateway.twitch.registerApp(clientId, secret);
    await gateway.identify(clientId, secret);
});

afterEach((): void => {
    gateway.dispose();
    setSystemTime();
});

/** Moves the clock forward. */
function daysLater(days: number): void {
    setSystemTime(new Date(Date.now() + days * day));
}

describe("inactive apps", (): void => {
    test("after 30 days without a client the conduit is deleted at Twitch", async (): Promise<void> => {
        daysLater(31);
        await gateway.appCleanupService.cleanUpInactiveApps();

        expect(gateway.twitch.conduitsOf(clientId)).toEqual([]);
        expect((await gateway.appStore.find(clientId))?.conduitId).toBeNull();
        expect(gateway.logger.messages("success")).toContain("Inactive, conduit deleted");
    });

    test("a session keeps the app active, however long it lasts", async (): Promise<void> => {
        gateway.appsWithSessions.add(clientId);
        daysLater(31);
        await gateway.appCleanupService.cleanUpInactiveApps();

        expect(gateway.twitch.conduitsOf(clientId)).toHaveLength(1);
    });

    test("29 days aren't enough", async (): Promise<void> => {
        daysLater(29);
        await gateway.appCleanupService.cleanUpInactiveApps();
        expect(gateway.twitch.conduitsOf(clientId)).toHaveLength(1);
    });

    test("the next IDENTIFY sets everything up again – with the users kept", async (): Promise<void> => {
        await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
        await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 111"));
        daysLater(31);
        await gateway.appCleanupService.cleanUpInactiveApps();

        const app: App | null = await gateway.identify(clientId, secret);
        expect(app?.conduitId).not.toBeNull();
        expect(gateway.twitch.subscriptionSummary(clientId)).toContain("channel.cheer 111");
    });
});
