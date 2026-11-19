import {describe, expect, test} from "bun:test";
import {EventSubSubscriptionHelper} from "@twitch/eventsub/EventSubSubscriptionHelper.ts";

describe("EventSubSubscriptionHelper", (): void => {
    test("subscriptionKey ignores the order and empty condition fields", (): void => {
        const a: string = EventSubSubscriptionHelper.subscriptionKey({type: "channel.chat.message", version: "1", condition: {broadcaster_user_id: "1", user_id: "2"}});
        const b: string = EventSubSubscriptionHelper.subscriptionKey({type: "channel.chat.message", version: "1", condition: {user_id: "2", broadcaster_user_id: "1", moderator_user_id: ""}});
        const otherVersion: string = EventSubSubscriptionHelper.subscriptionKey({type: "channel.chat.message", version: "2", condition: {broadcaster_user_id: "1", user_id: "2"}});

        expect(a).toBe(b);
        expect(a).not.toBe(otherVersion);
    });

    test("getConditionUserId finds the user, never one of the app-wide authorization subscriptions", (): void => {
        expect(EventSubSubscriptionHelper.getConditionUserId({type: "channel.follow", condition: {broadcaster_user_id: "1", moderator_user_id: "2"}})).toBe("1");
        expect(EventSubSubscriptionHelper.getConditionUserId({type: "channel.raid", condition: {to_broadcaster_user_id: "3"}})).toBe("3");
        expect(EventSubSubscriptionHelper.getConditionUserId({type: "user.update", condition: {user_id: "4"}})).toBe("4");
        expect(EventSubSubscriptionHelper.getConditionUserId({type: "user.authorization.grant", condition: {client_id: "abc"}})).toBeNull();
    });

    test("isOnConduit only matches the given conduit", (): void => {
        const sub: {transport: object} = {transport: EventSubSubscriptionHelper.conduitTransport("conduit-1")};

        expect(EventSubSubscriptionHelper.isOnConduit(sub, "conduit-1")).toBe(true);
        expect(EventSubSubscriptionHelper.isOnConduit(sub, "conduit-2")).toBe(false);
        expect(EventSubSubscriptionHelper.isOnConduit(sub, null)).toBe(false);
        expect(EventSubSubscriptionHelper.isOnConduit({transport: {method: "webhook", callback: "https://example.com"}}, "conduit-1")).toBe(false);
    });
});
