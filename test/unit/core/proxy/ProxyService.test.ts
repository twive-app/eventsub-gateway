import {describe, expect, test} from "bun:test";
import type {Server} from "bun";
import {loadConfig, provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {ProxyService} from "@core/proxy/ProxyService.ts";

/** A service whose TRUSTED_PROXIES are these. */
function service(trustedProxies: string): ProxyService {
    provideBean("configManager", new ConfigManagerMockup(loadConfig({TRUSTED_PROXIES: trustedProxies})));
    return new ProxyService();
}

/** Resolves a request from this socket address with this X-Forwarded-For. */
function resolve(proxy: ProxyService, socketAddress: string, forwardedFor?: string): {address: string; socketAddress: string} {
    const request: Request = new Request("http://localhost/health", {headers: forwardedFor ? {"x-forwarded-for": forwardedFor} : {}});
    const server: Server<undefined> = {requestIP: (): {address: string} => ({address: socketAddress})} as unknown as Server<undefined>;
    return proxy.resolve(request, server);
}

describe("ProxyService.resolve", (): void => {
    test("without trusted proxies X-Forwarded-For is ignored – it could be forged", (): void => {
        expect(resolve(service(""), "203.0.113.7", "1.2.3.4")).toEqual({address: "203.0.113.7", socketAddress: "203.0.113.7"});
    });

    test("behind a trusted proxy the client is the last untrusted entry", (): void => {
        const proxy: ProxyService = service("172.16.0.0/12");

        expect(resolve(proxy, "172.18.0.1", "198.51.100.9")).toEqual({address: "198.51.100.9", socketAddress: "172.18.0.1"});
        // A client can prepend anything – only the entries added by trusted proxies count.
        expect(resolve(proxy, "172.18.0.1", "1.2.3.4, 198.51.100.9").address).toBe("198.51.100.9");
        expect(resolve(proxy, "172.18.0.1", "198.51.100.9, 172.20.0.5").address).toBe("198.51.100.9");
    });

    test("IPv4-mapped IPv6 addresses count as IPv4", (): void => {
        expect(resolve(service("127.0.0.1"), "::ffff:127.0.0.1", "198.51.100.9").address).toBe("198.51.100.9");
        expect(resolve(service(""), "::ffff:7f00:1").address).toBe("127.0.0.1");
    });
});

describe("ProxyService.toLimitKey", (): void => {
    const proxy: ProxyService = service("");

    test("IPv4 addresses are counted on their own", (): void => {
        expect(proxy.toLimitKey("203.0.113.7", 64)).toBe("203.0.113.7");
    });

    test("IPv6 addresses are counted per prefix", (): void => {
        expect(proxy.toLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd", 64)).toBe("2001:db8:1:2::/64");
        expect(proxy.toLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd", 48)).toBe("2001:db8:1::/48");
        expect(proxy.toLimitKey("2001:DB8::1", 128)).toBe("2001:db8::1");
    });
});
