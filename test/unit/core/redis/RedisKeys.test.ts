import {beforeEach, expect, test} from "bun:test";
import {RedisKeys} from "@core/redis/RedisKeys.ts";

// Another test file may have left a prefix behind.
beforeEach((): void => {
    RedisKeys.setPrefix("");
});

test("keys start with twitch: and gateway: without a prefix", (): void => {
    expect(RedisKeys.twitch.app("abc")).toBe("twitch:apps:abc:app");
    expect(RedisKeys.gateway.session("abc", "s1")).toBe("gateway:apps:abc:sessions:s1:session");
});

test("REDIS_KEY_PREFIX goes in front of every key", (): void => {
    RedisKeys.setPrefix("twive:prod");
    expect(RedisKeys.twitch.appsIndex()).toBe("twive:prod:twitch:apps:index");
    expect(RedisKeys.twitch.appPublicSubscriptions("abc")).toBe("twive:prod:twitch:apps:abc:public");
    expect(RedisKeys.gateway.pendingConnection("c1")).toBe("twive:prod:gateway:pending:c1");
});

test("no key is the prefix of another key of the same app", (): void => {
    const keys: string[] = [
        RedisKeys.twitch.app("abc"),
        RedisKeys.twitch.appToken("abc"),
        RedisKeys.twitch.appUsers("abc"),
        RedisKeys.twitch.appPublicSubscriptions("abc"),
        RedisKeys.gateway.sessionsIndex("abc"),
        RedisKeys.gateway.session("abc", "s1"),
        RedisKeys.gateway.sessionSeq("abc", "s1"),
        RedisKeys.gateway.sessionBuffer("abc", "s1"),
        RedisKeys.gateway.connection("abc", "c1"),
    ];
    for (const key of keys) {
        for (const other of keys) {
            if (key !== other) expect(other.startsWith(`${key}:`)).toBe(false);
        }
    }
});
