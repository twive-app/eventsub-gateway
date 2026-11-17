import {describe, expect, test} from "bun:test";
import {EventSubTransportMethod, type EventSubConduitTransport, type RESTPostEventSubSubscriptionRequestBody} from "twitch-dev-types";
import {EventSubScopeService, type PublicSubscriptionCheck} from "@twitch/eventsub/EventSubScopeService.ts";

const service: EventSubScopeService = new EventSubScopeService();
const transport: EventSubConduitTransport = {method: EventSubTransportMethod.Conduit, conduit_id: "conduit-1"};
const user: string = "111";
const bot: string = "999";

/** "type v1 {condition}" of every subscription, for readable assertions. */
function describeSubs(subs: RESTPostEventSubSubscriptionRequestBody[]): string[] {
    return subs.map((sub: RESTPostEventSubSubscriptionRequestBody): string => `${sub.type} v${sub.version} ${JSON.stringify(sub.condition)}`);
}

/** Types of the subscriptions. */
function types(subs: RESTPostEventSubSubscriptionRequestBody[]): string[] {
    return subs.map((sub: RESTPostEventSubSubscriptionRequestBody): string => sub.type);
}

describe("EventSubScopeService.forUser", (): void => {
    test("every authorized user gets stream.online and stream.offline, without any scope", (): void => {
        expect(describeSubs(service.forUser([], null, user, transport, []))).toEqual([
            `stream.online v1 {"broadcaster_user_id":"${user}"}`,
            `stream.offline v1 {"broadcaster_user_id":"${user}"}`,
        ]);
    });

    test("a scope unlocks its subscriptions on the conduit", (): void => {
        const subs: RESTPostEventSubSubscriptionRequestBody[] = service.forUser(["bits:read"], null, user, transport, []);

        expect(types(subs)).toEqual(expect.arrayContaining(["channel.bits.use", "channel.cheer"]));
        for (const sub of subs) expect(sub.transport).toEqual(transport);
    });

    test("channel:bot needs a bot user – the chat subscriptions then read as the bot", (): void => {
        expect(types(service.forUser(["channel:bot"], null, user, transport, []))).not.toContain("channel.chat.message");

        const chat: RESTPostEventSubSubscriptionRequestBody | undefined = service.forUser(["channel:bot"], bot, user, transport, [])
            .find((sub: RESTPostEventSubSubscriptionRequestBody): boolean => sub.type === "channel.chat.message");
        expect(chat?.condition).toEqual({broadcaster_user_id: user, user_id: bot});
    });

    test("user:read:chat reads as the user itself, but only together with user:bot", (): void => {
        expect(types(service.forUser(["user:read:chat"], null, user, transport, []))).not.toContain("channel.chat.message");

        const chat: RESTPostEventSubSubscriptionRequestBody | undefined = service.forUser(["user:read:chat", "user:bot"], null, user, transport, [])
            .find((sub: RESTPostEventSubSubscriptionRequestBody): boolean => sub.type === "channel.chat.message");
        expect(chat?.condition).toEqual({broadcaster_user_id: user, user_id: user});
    });

    test("two scopes that unlock the same type create it only once", (): void => {
        const subs: RESTPostEventSubSubscriptionRequestBody[] = service.forUser(["channel:read:polls", "channel:manage:polls"], null, user, transport, []);
        const polls: string[] = types(subs).filter((type: string): boolean => type.startsWith("channel.poll."));

        expect(polls.length).toBeGreaterThan(0);
        expect(new Set<string>(polls).size).toBe(polls.length);
    });

    test("leaves out what already exists – compared by type, version and condition", (): void => {
        const existing: Pick<RESTPostEventSubSubscriptionRequestBody, "type" | "version" | "condition">[] = [
            {type: "stream.online", version: "1", condition: {broadcaster_user_id: user}},
            // Another user's subscription doesn't count.
            {type: "stream.offline", version: "1", condition: {broadcaster_user_id: "222"}},
        ] as never;

        expect(types(service.forUser([], null, user, transport, existing as never))).toEqual(["stream.offline"]);
    });

    test("channel.moderate needs all moderator read scopes, warnings make it version 2", (): void => {
        const moderator: string[] = [
            "moderator:read:blocked_terms", "moderator:read:chat_settings", "moderator:read:unban_requests",
            "moderator:read:banned_users", "moderator:read:chat_messages", "moderator:read:moderators", "moderator:read:vips",
        ];
        const moderate: (scopes: string[]) => RESTPostEventSubSubscriptionRequestBody | undefined = (scopes: string[]): RESTPostEventSubSubscriptionRequestBody | undefined => service.forUser(scopes, null, user, transport, [])
            .find((sub: RESTPostEventSubSubscriptionRequestBody): boolean => sub.type === "channel.moderate");

        expect(moderate(moderator.slice(1))).toBeUndefined();
        expect(moderate(moderator)?.version).toBe("1");
        expect(moderate([...moderator, "moderator:read:warnings"])?.version).toBe("2");
    });
});

describe("EventSubScopeService.checkPublicSubscription", (): void => {
    test("accepts a public type and fills in its version", (): void => {
        const check: PublicSubscriptionCheck = service.checkPublicSubscription({type: "stream.online", condition: {broadcaster_user_id: "123"}});
        expect(check).toEqual({valid: true, subscription: {type: "stream.online", version: "1", condition: {broadcaster_user_id: "123"}}});
    });

    test("channel.raid takes exactly one of its two fields", (): void => {
        expect(service.checkPublicSubscription({type: "channel.raid", condition: {to_broadcaster_user_id: "1"}}).valid).toBe(true);
        expect(service.checkPublicSubscription({type: "channel.raid", condition: {from_broadcaster_user_id: "1", to_broadcaster_user_id: "2"}}).valid).toBe(false);
        expect(service.checkPublicSubscription({type: "channel.raid", condition: {}}).valid).toBe(false);
    });

    test.each([
        ["no object", "stream.online"],
        ["a type that needs authorization", {type: "channel.cheer", condition: {broadcaster_user_id: "1"}}],
        ["a wrong version", {type: "channel.update", version: "1", condition: {broadcaster_user_id: "1"}}],
        ["a missing condition", {type: "stream.online"}],
        ["an unknown condition field", {type: "stream.online", condition: {broadcaster_user_id: "1", user_id: "2"}}],
        ["a user id that isn't numeric", {type: "stream.online", condition: {broadcaster_user_id: "abc"}}],
        ["a user id as number", {type: "stream.online", condition: {broadcaster_user_id: 1}}],
        ["an empty condition", {type: "user.update", condition: {}}],
    ])("rejects %s", (_name: string, body: unknown): void => {
        const check: PublicSubscriptionCheck = service.checkPublicSubscription(body);
        expect(check.valid).toBe(false);
        if (!check.valid) expect(check.message.length).toBeGreaterThan(0);
    });
});

describe("EventSubScopeService helpers", (): void => {
    test("subscriptionKey ignores the order and empty condition fields", (): void => {
        const a: string = service.subscriptionKey({type: "channel.chat.message", version: "1", condition: {broadcaster_user_id: "1", user_id: "2"}});
        const b: string = service.subscriptionKey({type: "channel.chat.message", version: "1", condition: {user_id: "2", broadcaster_user_id: "1", moderator_user_id: ""}});
        const otherVersion: string = service.subscriptionKey({type: "channel.chat.message", version: "2", condition: {broadcaster_user_id: "1", user_id: "2"}});

        expect(a).toBe(b);
        expect(a).not.toBe(otherVersion);
    });

    test("getBotUserId finds the bot of a bot chat subscription only", (): void => {
        expect(service.getBotUserId({type: "channel.chat.message", version: "1", condition: {broadcaster_user_id: user, user_id: bot}} as never)).toBe(bot);
        // The user reading its own chat (user:read:chat) is no bot subscription.
        expect(service.getBotUserId({type: "channel.chat.message", version: "1", condition: {broadcaster_user_id: user, user_id: user}} as never)).toBeNull();
        expect(service.getBotUserId({type: "stream.online", version: "1", condition: {broadcaster_user_id: user}} as never)).toBeNull();
    });

    test("isCreatedForAuthorizedUsers knows the types the gateway creates itself", (): void => {
        expect(service.isCreatedForAuthorizedUsers("stream.online")).toBe(true);
        expect(service.isCreatedForAuthorizedUsers("user.update")).toBe(true);
        expect(service.isCreatedForAuthorizedUsers("channel.raid")).toBe(false);
    });

    test("appSubscriptions are the authorization grant and revoke of the app", (): void => {
        expect(describeSubs(service.appSubscriptions("abc", transport))).toEqual([
            'user.authorization.grant v1 {"client_id":"abc"}',
            'user.authorization.revoke v1 {"client_id":"abc"}',
        ]);
    });
});
