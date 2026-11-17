import {describe, expect, test} from "bun:test";
import {ErrorReporter, MainError, type ErrorReport} from "@core/error/ErrorReporter.ts";
import {HttpError} from "@core/http/HttpClient.ts";

const reporter: ErrorReporter = new ErrorReporter();

/** A failed token request like Twitch would answer it. */
function tokenError(): HttpError {
    return new HttpError(400, "POST", "https://id.twitch.tv/oauth2/token?client_secret=abc&grant_type=client_credentials", {status: 400, message: "invalid client secret"}, {
        requestHeaders: {"Content-Type": "application/json", "Authorization": "Bearer token-123", "Client-Id": "abc"},
        requestBody: {client_id: "abc", client_secret: "very-secret"},
        responseHeaders: {"set-cookie": "session=1", "ratelimit-remaining": "799"},
    });
}

describe("ErrorReporter", (): void => {
    test("knows sensitive keys in any case", (): void => {
        expect(reporter.isSensitive("Authorization")).toBe(true);
        expect(reporter.isSensitive("client_secret")).toBe(true);
        expect(reporter.isSensitive("accessToken")).toBe(true);
        expect(reporter.isSensitive("clientId")).toBe(false);
    });

    test("redacts nested objects and arrays", (): void => {
        expect(reporter.redact({app: "abc", nested: [{token: "t"}, {password: "p", keep: 1}]})).toEqual({
            app: "abc",
            nested: [{token: "***REDACTED***"}, {password: "***REDACTED***", keep: 1}],
        });
    });

    test("a failed request is reported in full – but without any secret", (): void => {
        const report: ErrorReport = reporter.report(tokenError(), false);
        const text: string = JSON.stringify(report);

        expect(report.error.code).toBe("HTTP_ERROR");
        expect(report.error.message).toBe("POST id.twitch.tv/oauth2/token failed with status 400");
        expect(text).toContain("invalid client secret");
        expect(text).toContain("ratelimit-remaining");
        expect(text).toContain("client_secret=***REDACTED***");
        for (const secret of ["token-123", "very-secret", "client_secret=abc", "session=1"]) expect(text).not.toContain(secret);
    });

    test("own errors keep their code; the location is our own code, not the test runner", (): void => {
        const report: ErrorReport = reporter.report(new MainError("APP_NOT_FOUND", "gone"), false);

        expect(report.error).toEqual({code: "APP_NOT_FOUND", message: "gone"});
        expect(report.location?.file).toBe("ErrorReporter.test.ts");
        expect(report.stack).toBeUndefined();
    });

    test("bugs always get the stack, other errors only on request", (): void => {
        expect(reporter.report(new TypeError("x is undefined"), false).stack?.length).toBeGreaterThan(0);
        expect(reporter.report(new MainError("A", "b"), true).stack?.length).toBeGreaterThan(0);
        expect(reporter.isBug(new RangeError("r"))).toBe(true);
        expect(reporter.isBug(new MainError("A", "b"))).toBe(false);
    });

    test("anything else thrown is redacted as details", (): void => {
        expect(reporter.report({token: "t", reason: "x"}, false).error).toEqual({code: "UNKNOWN_ERROR", message: "Unknown error", details: {token: "***REDACTED***", reason: "x"}});
        expect(reporter.report("plain text", false).error).toEqual({code: "UNKNOWN_ERROR", message: "plain text"});
    });
});
