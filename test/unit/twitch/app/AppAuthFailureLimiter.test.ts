import {afterEach, beforeEach, describe, expect, setSystemTime, test} from "bun:test";
import {HttpProxyService} from "@core/http/HttpProxyService.ts";
import {AppAuthFailureLimiter} from "@twitch/app/AppAuthFailureLimiter.ts";
import {loadConfig, provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

const start: Date = new Date(2026, 10, 17, 12, 0, 0);
let logger: LoggerMockup;

/** A limiter with these GATEWAY_ variables. */
function createLimiter(env: Record<string, string> = {}): AppAuthFailureLimiter {
    logger = new LoggerMockup();
    provideBean("configManager", new ConfigManagerMockup(loadConfig(env)));
    provideBean("httpProxyService", new HttpProxyService());
    provideBean("logger", logger);
    return new AppAuthFailureLimiter();
}

beforeEach((): void => {
    setSystemTime(start);
});

afterEach((): void => {
    setSystemTime();
});

describe("AppAuthFailureLimiter", (): void => {
    test("the limit blocks the address until the window ends", (): void => {
        const limiter: AppAuthFailureLimiter = createLimiter({GATEWAY_AUTH_FAILURE_LIMIT: "3", GATEWAY_AUTH_FAILURE_WINDOW_MS: "60000"});
        limiter.recordFailure("203.0.113.5");
        limiter.recordFailure("203.0.113.5");
        expect(limiter.isBlocked("203.0.113.5")).toBe(false);

        limiter.recordFailure("203.0.113.5");
        expect(limiter.isBlocked("203.0.113.5")).toBe(true);
        expect(limiter.isBlocked("203.0.113.6")).toBe(false);

        setSystemTime(new Date(start.getTime() + 60000));
        expect(limiter.isBlocked("203.0.113.5")).toBe(false);
    });

    test("the block is logged once, not for every further attempt", (): void => {
        const limiter: AppAuthFailureLimiter = createLimiter({GATEWAY_AUTH_FAILURE_LIMIT: "2"});
        for (let i: number = 0; i < 5; i++) limiter.recordFailure("203.0.113.5");
        expect(logger.messages("warn")).toEqual(["Too many failed authentications, address blocked"]);
    });

    test("failures of an ended window don't count anymore", (): void => {
        const limiter: AppAuthFailureLimiter = createLimiter({GATEWAY_AUTH_FAILURE_LIMIT: "2", GATEWAY_AUTH_FAILURE_WINDOW_MS: "60000"});
        limiter.recordFailure("203.0.113.5");

        setSystemTime(new Date(start.getTime() + 61000));
        limiter.recordFailure("203.0.113.5");
        expect(limiter.isBlocked("203.0.113.5")).toBe(false);
    });

    test("limit 0 turns the block off", (): void => {
        const limiter: AppAuthFailureLimiter = createLimiter({GATEWAY_AUTH_FAILURE_LIMIT: "0"});
        for (let i: number = 0; i < 20; i++) limiter.recordFailure("203.0.113.5");
        expect(limiter.isBlocked("203.0.113.5")).toBe(false);
    });
});
