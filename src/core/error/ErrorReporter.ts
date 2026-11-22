import {Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";

/** Own error with a machine-readable code as name, e.g. new MainError("APP_NOT_FOUND", "…"). */
export class MainError extends Error {
    public constructor(
        public readonly name: string,
        message: string,
    ) {
        super(message);
        this.name = name;
    }
}

/** Where an error happened: the first stack frame of our own code. */
export interface ErrorLocation {
    file: string;
    line: number;
    method?: string;
}

/** The JSON block the Logger prints below an error line – everything redacted. */
export interface ErrorReport {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
    location: ErrorLocation | null;
    // Only for bugs (TypeError & co.) and with LOG_DEBUG.
    stack?: string[];
}

// Keys whose values never appear in a log (compared in lower case).
const sensitiveKeys: Set<string> = new Set<string>([
    "password", "pass", "token", "accesstoken", "access_token", "refreshtoken", "refresh_token",
    "authorization", "clientsecret", "client_secret", "secret", "secretkey", "cookie", "set-cookie",
]);

// Stack frames that only pass an error on – the location is the first frame outside them.
const internalFiles: Set<string> = new Set<string>(["HttpClient.ts", "TwitchClient.ts", "ErrorReporter.ts", "Logger.ts"]);
const stackFramePattern: RegExp = /^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/;
const maxStackFrames: number = 10;

/** Describes errors for the Logger – code, message, details (a failed request in full) and location; never logs itself. */
@Bean()
export class ErrorReporter {
    /** Whether the value of this key must never be logged. */
    public isSensitive(key: string): boolean {
        return sensitiveKeys.has(key.toLowerCase());
    }

    /** Replaces the values of sensitive keys, recursively. */
    public redact(value: unknown): unknown {
        if (value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map((entry: unknown): unknown => this.redact(entry));

        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            out[key] = this.isSensitive(key) ? "***REDACTED***" : this.redact(entry);
        }
        return out;
    }

    /** The full, redacted report; `withStack` adds our own stack frames. */
    public report(error: unknown, withStack: boolean): ErrorReport {
        const frames: ErrorLocation[] = error instanceof Error && error.stack ? this.ownFrames(error.stack) : [];
        const report: ErrorReport = {error: this.describe(error), location: frames[0] ?? null};

        if (withStack || this.isBug(error)) {
            report.stack = frames.map((frame: ErrorLocation): string => `${frame.file}:${frame.line}${frame.method ? ` ${frame.method}` : ""}`);
        }
        return report;
    }

    /** A programming error (TypeError & co.) – its stack is always worth printing. */
    public isBug(error: unknown): boolean {
        return error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
    }

    /** Code, message and details – for a failed request the request, the response and its body. */
    private describe(error: unknown): ErrorReport["error"] {
        if (error instanceof HttpError) return {
            code: "HTTP_ERROR",
            message: `${error.method} ${this.endpoint(error.url)} failed with status ${error.status}`,
            details: this.redact({
                request: {
                    method: error.method,
                    url: this.redactUrl(error.url),
                    headers: error.exchange?.requestHeaders,
                    body: error.exchange?.requestBody,
                },
                response: {
                    status: error.status,
                    headers: error.exchange?.responseHeaders,
                    body: error.body,
                },
            }),
        };

        if (error instanceof Error) return {
            code: error.name,
            message: error.message,
        };
        if (typeof error === "string") return {
            code: "UNKNOWN_ERROR",
            message: error,
        };
        return {
            code: "UNKNOWN_ERROR",
            message: "Unknown error",
            details: this.redact(error),
        };
    }

    /** Host and path of a URL – for the short texts, the query may contain secrets. */
    private endpoint(url: string): string {
        if (!URL.canParse(url)) return url;
        const parsed: URL = new URL(url);
        return `${parsed.host}${parsed.pathname}`;
    }

    /** The URL with the values of sensitive query parameters replaced. */
    private redactUrl(url: string): string {
        if (!URL.canParse(url)) return url;

        const parsed: URL = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (this.isSensitive(key)) parsed.searchParams.set(key, "***REDACTED***");
        }
        return parsed.toString();
    }

    /** The stack frames of our own code. */
    private ownFrames(stack: string): ErrorLocation[] {
        const frames: ErrorLocation[] = [];
        for (const line of stack.split("\n").slice(1)) {
            const match: RegExpExecArray | null = stackFramePattern.exec(line.trim());
            if (!match) continue;

            const [, method, file, lineNumber]: RegExpExecArray = match;
            const name: string = file.split("/").pop() ?? file;
            // Exact file names – a substring would also hide e.g. ErrorReporter.test.ts or LoggerSomething.ts.
            if (file.includes("node_modules") || file.startsWith("node:") || internalFiles.has(name)) continue;

            frames.push({
                file: name,
                line: Number(lineNumber),
                method: method ?? undefined,
            });
            if (frames.length === maxStackFrames) break;
        }
        return frames;
    }
}
