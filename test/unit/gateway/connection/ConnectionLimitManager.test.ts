import {afterEach, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import {HttpProxyService} from "@core/http/HttpProxyService.ts";
import {GatewayCloseCode} from "@gateway/GatewayProtocol.ts";
import {ConnectionLimitManager} from "@gateway/connection/ConnectionLimitManager.ts";
import {loadConfig, provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

const start: Date = new Date(2026, 10, 17, 12, 0, 0);
let logger: LoggerMockup;

/** A manager with these GATEWAY_ variables. */
function limits(env: Record<string, string> = {}): ConnectionLimitManager {
    logger = new LoggerMockup();
    provideBean("configManager", new ConfigManagerMockup(loadConfig(env)));
    provideBean("httpProxyService", new HttpProxyService());
    provideBean("logger", logger);
    return new ConnectionLimitManager();
}

beforeEach((): void => {
    setSystemTime(start);
});

afterEach((): void => {
    setSystemTime();
});

describe("ConnectionLimitManager connections", (): void => {
    test("limit per address – another address isn't affected, release frees the slot", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_MAX_CONNECTIONS_PER_IP: "2"});
        expect(manager.acquire("203.0.113.5")).toBeNull();
        expect(manager.acquire("203.0.113.5")).toBeNull();
        expect(manager.acquire("203.0.113.5")).toEqual({code: GatewayCloseCode.RateLimited, reason: "Too many connections from your address"});
        expect(manager.acquire("203.0.113.6")).toBeNull();

        manager.release("203.0.113.5");
        expect(manager.acquire("203.0.113.5")).toBeNull();
    });

    test("total limit over all addresses", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_MAX_CONNECTIONS: "2"});
        expect(manager.acquire("203.0.113.5")).toBeNull();
        expect(manager.acquire("203.0.113.6")).toBeNull();
        expect(manager.acquire("203.0.113.7")).toEqual({code: GatewayCloseCode.RateLimited, reason: "Too many connections, try again later"});
    });

    test("IPv6 addresses of one /64 share their limit", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_MAX_CONNECTIONS_PER_IP: "1"});
        expect(manager.acquire("2001:db8::1")).toBeNull();
        expect(manager.acquire("2001:db8::2")).not.toBeNull();
        expect(manager.acquire("2001:db8:0:1::1")).toBeNull();
    });

    test("releasing an address without a connection doesn't free a slot of another", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_MAX_CONNECTIONS: "1"});
        manager.release("203.0.113.9");
        expect(manager.acquire("203.0.113.5")).toBeNull();
        expect(manager.acquire("203.0.113.6")).not.toBeNull();
    });
});

describe("ConnectionLimitManager auth failures", (): void => {
    const blocked: {code: GatewayCloseCode; reason: string} = {code: GatewayCloseCode.RateLimited, reason: "Too many failed authentication attempts, try again later"};

    test("the limit blocks the address – also for new connections – until the window ends", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_AUTH_FAILURE_LIMIT: "3", GATEWAY_AUTH_FAILURE_WINDOW_MS: "60000"});
        manager.recordAuthFailure("203.0.113.5");
        manager.recordAuthFailure("203.0.113.5");
        expect(manager.getAuthRejection("203.0.113.5")).toBeNull();

        manager.recordAuthFailure("203.0.113.5");
        expect(manager.getAuthRejection("203.0.113.5")).toEqual(blocked);
        expect(manager.acquire("203.0.113.5")).toEqual(blocked);
        expect(manager.getAuthRejection("203.0.113.6")).toBeNull();

        setSystemTime(new Date(start.getTime() + 60000));
        expect(manager.getAuthRejection("203.0.113.5")).toBeNull();
        expect(manager.acquire("203.0.113.5")).toBeNull();
    });

    test("the block is logged once, not for every further attempt", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_AUTH_FAILURE_LIMIT: "2"});
        for (let i: number = 0; i < 5; i++) manager.recordAuthFailure("203.0.113.5");
        expect(logger.messages("warn")).toEqual(["Too many failed authentications, address blocked"]);
    });

    test("failures of an ended window don't count anymore", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_AUTH_FAILURE_LIMIT: "2", GATEWAY_AUTH_FAILURE_WINDOW_MS: "60000"});
        manager.recordAuthFailure("203.0.113.5");

        setSystemTime(new Date(start.getTime() + 61000));
        manager.recordAuthFailure("203.0.113.5");
        expect(manager.getAuthRejection("203.0.113.5")).toBeNull();
    });

    test("limit 0 turns the block off", (): void => {
        const manager: ConnectionLimitManager = limits({GATEWAY_AUTH_FAILURE_LIMIT: "0"});
        for (let i: number = 0; i < 20; i++) manager.recordAuthFailure("203.0.113.5");
        expect(manager.getAuthRejection("203.0.113.5")).toBeNull();
    });
});
