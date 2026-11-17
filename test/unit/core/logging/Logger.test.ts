import {afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test, type Mock} from "bun:test";
import {ErrorReporter, MainError} from "@core/error/ErrorReporter.ts";
import {Logger} from "@core/logging/Logger.ts";
import {loadConfig, provideBean} from "../../../helpers.ts";
import {ConfigManagerMockup} from "../../../mockups/ConfigManagerMockup.ts";

const ansi: RegExp = /\u001b\[[0-9;]*m/g;
let output: Mock<typeof console.log>;

/** A logger with LOG_DEBUG on or off. */
function logger(debug: boolean = false): Logger {
    provideBean("configManager", new ConfigManagerMockup(loadConfig({LOG_DEBUG: String(debug)})));
    provideBean("errorReporter", new ErrorReporter());
    return new Logger();
}

/** Everything printed, without colors. */
function printed(): string[] {
    return output.mock.calls.map((args: unknown[]): string => args.map(String).join(" ").replace(ansi, ""));
}

beforeEach((): void => {
    output = spyOn(console, "log").mockImplementation((): undefined => undefined);
    setSystemTime(new Date(2026, 10, 16, 19, 20, 1));
});

afterEach((): void => {
    output.mockRestore();
    setSystemTime();
});

describe("Logger", (): void => {
    test("secrets are masked, in the line and in the error report", (): void => {
        const fields: Record<string, unknown> = {token: "token-123", nested: {client_secret: "secret-456"}};
        logger().info("REDIS", "Connection lost", fields);
        logger().error("CONDUIT", "Could not create a conduit", fields, new MainError("CONDUIT_FAILED", "nope"));
        const text: string = printed().join("\n");

        expect(text).not.toContain("token-123");
        expect(text).not.toContain("secret-456");
        expect(text).toContain("token=***");
    });

    test("line breaks from client input can't fake a log line", (): void => {
        logger().warn("AUTH", "Rejected\nfake", {app: "abc\n2026-11-16 19:20:01 [INFO] [SYSTEM] | forged"});
        const lines: string[] = printed();

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("Rejected\\nfake");
        expect(lines[0]).toContain("abc\\n2026");
    });

    test("debug lines only with LOG_DEBUG", (): void => {
        logger(false).debug("HTTP", "GET /health");
        expect(printed()).toEqual([]);

        logger(true).debug("HTTP", "GET /health");
        expect(printed()).toHaveLength(1);
    });

    test("warnThrottled prints once per 30 s and counts what it suppressed", (): void => {
        const log: Logger = logger();
        for (let i: number = 0; i < 4; i++) log.warnThrottled("DISPATCH", "Could not deliver an event", {conn: `c${i}`});
        // Another message is throttled on its own.
        log.warnThrottled("CONNECTION", "Could not record a heartbeat");
        expect(printed()).toHaveLength(2);

        setSystemTime(new Date(2026, 10, 16, 19, 20, 31));
        log.warnThrottled("DISPATCH", "Could not deliver an event", {conn: "c9"});
        expect(printed()[2]).toContain("suppressed=3");
    });
});
