import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import {HttpError} from "@core/http/HttpClient.ts";
import {Logger, type LogModule} from "@core/logging/Logger.ts";
import chalk from "chalk";

type ErrorContext = Record<string, unknown>;

interface ErrorLocation {
    file: string;
    line: number;
    method?: string;
}

interface NormalizedError {
    code: string;
    message: string;
    details?: unknown;
    stack?: string;
}

interface ErrorPayload {
    timestamp: string;
    error: {
        code: string;
        message: string;
        details: unknown;
    };
    context: unknown;
    location: ErrorLocation | null;
}

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

const throttleIntervalMs: number = 30000;

/** Logs errors as one JSON block with location and context – secrets in details, context and URLs are redacted. */
@Bean()
export class ErrorReporter {
    @Autowired()
    private logger!: Logger;

    private lastThrottledAt: number = 0;

    // Keys whose values never appear in a log (compared in lower case).
    private readonly sensitiveKeys: Set<string> = new Set<string>([
        "password", "pass", "token", "accesstoken", "access_token", "refreshtoken", "refresh_token",
        "authorization", "clientsecret", "client_secret", "secret", "secretkey", "cookie", "set-cookie",
    ]);

    /** Turns anything thrown into code, message, details and stack. */
    public normalize(error: unknown): NormalizedError {
        if (error instanceof HttpError) return {
            code: "HTTP_ERROR",
            message: `${error.method} ${this.redactUrl(error.url)} failed with status ${error.status}`,
            details: {
                method: error.method,
                url: this.redactUrl(error.url),
                status: error.status,
                response: error.body,
            },
            stack: error.stack,
        };

        if (error instanceof Error) return {
            code: error.name,
            message: error.message,
            stack: error.stack,
        };

        return {
            code: "UNKNOWN_ERROR",
            message: typeof error === "string" ? error : "Unknown error",
            details: error,
        };
    }

    /** Logs a normalized error with its redacted context and the first own source location. */
    public log(error: NormalizedError, context?: ErrorContext): NormalizedError {
        const location: ErrorLocation | null = error.stack ? this.parseStackTrace(error.stack) : null;

        const payload: ErrorPayload = {
            timestamp: Logger.formatDate(new Date(), {schema: "dd-MM-yyyy HH:mm:ss"}),
            error: {
                code: error.code,
                message: error.message,
                details: this.redact(error.details),
            },
            context: this.redact(context ?? {}),
            location,
        };

        console.log(chalk.hex("#fc3a4a")(JSON.stringify(payload, null, 2)));
        return error;
    }

    /** Normalizes and logs an error in one step. */
    public handle(error: unknown, context?: ErrorContext): NormalizedError {
        return this.log(this.normalize(error), context);
    }

    /** Logs at most one error every 30 s – for errors that can repeat for every request or event. */
    public handleThrottled(logModule: keyof typeof LogModule, message: string, error: unknown): void {
        const now: number = Date.now();
        if (now - this.lastThrottledAt < throttleIntervalMs) return;

        this.lastThrottledAt = now;
        this.logger.warning(logModule, message);
        this.handle(error);
    }

    /** Replaces the values of sensitive keys, recursively. */
    private redact(value: unknown): unknown {
        if (value === null || value === undefined) return value;
        if (Array.isArray(value)) return value.map((v: unknown): unknown => this.redact(v));
        if (typeof value !== "object") return value;

        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (this.sensitiveKeys.has(k.toLowerCase())) {
                out[k] = "***REDACTED***";
            } else {
                out[k] = this.redact(v);
            }
        }
        return out;
    }

    /** Replaces the values of sensitive query parameters of a URL. */
    private redactUrl(url: string): string {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return url;
        }

        for (const key of [...parsed.searchParams.keys()]) {
            if (this.sensitiveKeys.has(key.toLowerCase())) parsed.searchParams.set(key, "***REDACTED***");
        }
        return parsed.toString();
    }

    /** First stack frame outside node_modules and the wrappers, i.e. where the error really happened. */
    private parseStackTrace(stack: string): ErrorLocation | null {
        if (!stack) return null;

        const lines: string[] = stack.split("\n").map((line: string): string => line.trim());
        const stackRegex: RegExp = /^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/;

        for (const line of lines.slice(1)) {
            const match: RegExpMatchArray | null = stackRegex.exec(line);
            if (!match) continue;

            const [, method, file, lineNum]: RegExpMatchArray = match;

            if (this.isInternalFile(file)) continue;

            return {
                file: file.split("/").pop() ?? file,
                line: Number(lineNum),
                method: method ?? undefined,
            };
        }

        return null;
    }

    /** Files to skip in the stack trace – they only pass the error on. */
    private isInternalFile(file: string): boolean {
        const internal: string[] = [
            "node_modules",
            "node:events",
            "node:domain",
            "node:internal",
            "HttpClient",
            "TwitchClient",
            "ErrorReporter",
        ];
        return internal.some((i: string): boolean => file.includes(i));
    }
}
