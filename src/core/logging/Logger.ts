import chalk, {type ChalkInstance} from "chalk";
import figlet from "figlet";
import slantFont from "figlet/importable-fonts/Slant.js";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import type {ErrorReport, ErrorReporter} from "@core/error/ErrorReporter.ts";

/** Details of a log line, printed after the message as key=value – ids belong here, not into the message. */
export type LogFields = Record<string, unknown>;

/** Areas of the gateway a log line belongs to, with their colors. */
export enum LogModule {
    SYSTEM = "#3b26f6",
    REDIS = "#e74c3c",
    HTTP = "#b9ff4f",
    HEALTH = "#69db7c",
    AUTH = "#4dabf7",
    APP = "#ffd43b",
    CONDUIT = "#da77f2",
    EVENTSUB = "#9146ff",
    WEBHOOK = "#b197fc",
    GATEWAY = "#ffcc5d",
    CONNECTION = "#ffa94d",
    SESSION = "#f783ac",
    DISPATCH = "#63e6be",
}

type LogLevel = "debug" | "info" | "success" | "warn" | "error";

/** One log line as it was written – kept until it can be printed. */
interface LogLine {
    level: LogLevel;
    logModule: keyof typeof LogModule;
    message: string;
    fields?: LogFields;
    error?: unknown;
    at: Date;
}

/** What the Logger prints: the startup banner, an empty line or a line. */
interface LogEntry {
    banner?: true;
    spacer?: true;
    line?: LogLine;
}

// Fixed widths, so messages start in the same column: "2026-11-16 19:20:01 [INFO]  [SESSION]    | …".
const levelStyles: Record<LogLevel, {label: string; color: ChalkInstance}> = {
    debug: {
        label: "DEBUG",
        color: chalk.hex("#cccb94"),
    },
    info: {
        label: "INFO",
        color: chalk.hex("#3ae1ff"),
    },
    success: {
        label: "SUCCESS",
        color: chalk.hex("#3afc77"),
    },
    warn: {
        label: "WARN",
        color: chalk.hex("#fca13a"),
    },
    error: {
        label: "ERROR",
        color: chalk.hex("#fc3a4a"),
    },
};
const levelWidth: number = 7;
const moduleWidth: number = 10;
const moduleColors: Map<string, ChalkInstance> = new Map<string, ChalkInstance>(
    Object.entries(LogModule).map(([name, color]: [string, string]): [string, ChalkInstance] => [name, chalk.hex(color)]),
);
const maxFieldLength: number = 120;
const throttleIntervalMs: number = 30000;

figlet.parseFont("Slant", slantFont);

// Control characters (code points 0–31 and 127) and how they are written instead.
const controlCharacters: RegExp = new RegExp("[\\x00-\\x1f\\x7f]", "g");
const controlNames: Record<string, string> = {"\n": "\\n", "\r": "\\r", "\t": "\\t"};

/** Line breaks and other control characters escaped (\\n, \\u0007 …) – client input can never start a fake log line. */
function escapeControl(text: string): string {
    return text.replace(controlCharacters, (char: string): string => controlNames[char]
        ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

/** Two digits with a leading zero. */
function pad2(value: number): string {
    return value < 10 ? `0${value}` : value.toString();
}

/** "2026-11-16 19:20:01" in the time zone of the process (TZ). */
function timestamp(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * One line per event: time, [level], [module] | a short message and its details as key=value. Errors add one indented
 * line (what failed, where); bugs and LOG_DEBUG add the stack. Secrets in fields are never printed.
 */
@Bean()
export class Logger {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private errorReporter!: ErrorReporter;

    // LOG_DEBUG and LOG_FORMAT, read on the first use – the configuration never changes at runtime.
    private debugEnabled: boolean | null = null;
    private json: boolean | null = null;
    // Lines before the configuration loaded (banner, "Starting") – printed once the format is known.
    private readonly early: LogEntry[] = [];
    // Per module + message: until when further lines are suppressed, and how many were.
    private readonly throttled: Map<string, {until: number; suppressed: number}> = new Map<string, {until: number; suppressed: number}>();

    /** The ASCII art banner on startup, followed by "powered by twive.app" – only in the pretty format. */
    public header(): void {
        this.output({
            banner: true,
        });
    }

    /** An empty line to set something apart (e.g. the shutdown after ^C) – only in the pretty format. */
    public spacer(): void {
        this.output({
            spacer: true,
        });
    }

    /** High-frequency details (every request, event, connection) – only with LOG_DEBUG=true. */
    public debug(logModule: keyof typeof LogModule, message: string, fields?: LogFields): void {
        if (this.isDebugEnabled()) this.write("debug", logModule, message, fields);
    }

    /** Normal operation and state changes, e.g. a session disconnected. */
    public info(logModule: keyof typeof LogModule, message: string, fields?: LogFields): void {
        this.write("info", logModule, message, fields);
    }

    /** An action completed successfully, e.g. a conduit was created or a session identified. */
    public success(logModule: keyof typeof LogModule, message: string, fields?: LogFields): void {
        this.write("success", logModule, message, fields);
    }

    /** Something unexpected the gateway handles itself; `error` adds what went wrong. */
    public warn(logModule: keyof typeof LogModule, message: string, fields?: LogFields, error?: unknown): void {
        this.write("warn", logModule, message, fields, error);
    }

    /** Something failed; `error` adds what went wrong and where. */
    public error(logModule: keyof typeof LogModule, message: string, fields?: LogFields, error?: unknown): void {
        this.write("error", logModule, message, fields, error);
    }

    /** A warning that can repeat for every request or event: at most once per 30 s, with the number suppressed meanwhile. */
    public warnThrottled(logModule: keyof typeof LogModule, message: string, fields?: LogFields, error?: unknown): void {
        const key: string = `${logModule}:${message}`;
        const now: number = Date.now();
        const state: {
            until: number;
            suppressed: number;
        } | undefined = this.throttled.get(key);

        if (state && now < state.until) {
            state.suppressed++;
            return;
        }

        this.throttled.set(key, {
            until: now + throttleIntervalMs,
            suppressed: 0,
        });
        this.write("warn", logModule, message, state?.suppressed ? {
            ...fields,
            suppressed: state.suppressed,
        } : fields, error);
    }

    /** Whether debug lines are written – lets hot paths skip building a message nobody sees. */
    public isDebugEnabled(): boolean {
        // Before the configuration loaded (or when it is invalid) there is no LOG_DEBUG – the error must still be printed.
        if (this.debugEnabled === null && !this.configManager.isLoaded()) return false;

        this.debugEnabled ??= this.configManager.get().logging.debug;
        return this.debugEnabled;
    }

    /** A log line – printed right away, or once the configuration says in which format. */
    private write(level: LogLevel, logModule: keyof typeof LogModule, message: string, fields?: LogFields, error?: unknown): void {
        this.output({
            line: {
                level,
                logModule,
                message,
                fields,
                error,
                at: new Date(),
            },
        });
    }

    /**
     * Prints an entry in the configured format. Before the configuration loaded, entries wait – an error prints them
     * (pretty, the format is unknown) so a broken configuration is never swallowed.
     */
    private output(entry: LogEntry): void {
        if (!this.configManager.isLoaded() && !(entry.line?.level === "error")) {
            this.early.push(entry);
            return;
        }

        for (const waiting of this.early.splice(0)) this.print(waiting);
        this.print(entry);
    }

    /** One entry in the format of the configuration (pretty while it isn't loaded). */
    private print(entry: LogEntry): void {
        this.json ??= this.configManager.isLoaded() ? this.configManager.get().logging.format === "json" : null;
        const json: boolean = this.json ?? false;

        if (entry.banner || entry.spacer) {
            if (json) return;
            if (entry.banner) this.printBanner();
            else console.log("");
            return;
        }
        if (!entry.line) return;

        if (json) this.printJson(entry.line);
        else this.printPretty(entry.line);
    }

    /** One JSON object per line – fields and the error report redacted, nothing escaped by hand. */
    private printJson({level, logModule, message, fields, error, at}: LogLine): void {
        const record: Record<string, unknown> = {
            time: at.toISOString(),
            level,
            module: logModule,
            message,
        };
        if (fields) record.fields = this.errorReporter.redact(fields);

        if (error !== undefined) {
            const report: ErrorReport = this.errorReporter.report(error, this.isDebugEnabled());
            record.error = report.error;
            record.location = report.location;
            if (report.stack) record.stack = report.stack;
        }
        console.log(JSON.stringify(record));
    }

    /** The colored line, and for an error the indented details below it. */
    private printPretty({level, logModule, message, fields, error, at}: LogLine): void {
        const style: {label: string; color: ChalkInstance} = levelStyles[level];
        const moduleColor: ChalkInstance = moduleColors.get(logModule) ?? chalk.white;
        const details: string = fields ? this.formatFields(fields) : "";

        const levelLabel: string = `[${style.color(style.label)}]${" ".repeat(levelWidth - style.label.length)}`;
        const area: string = `[${moduleColor(logModule)}]${" ".repeat(moduleWidth - logModule.length)}`;

        console.log(`${timestamp(at)} ${levelLabel} ${area} | ${escapeControl(message)}${details ? ` : ${chalk.gray(details)}` : ""}`);
        if (error === undefined) return;

        // The full report below the line: error, failed request/response, the fields unshortened, location.
        const report: ErrorReport = this.errorReporter.report(error, this.isDebugEnabled());
        const block: object = {
            error: report.error,
            context: fields ? this.errorReporter.redact(fields) : undefined,
            location: report.location,
            stack: report.stack,
        };
        console.log(style.color(JSON.stringify(block, null, 2)));
    }

    /** The ASCII art banner. */
    private printBanner(): void {
        const color: string = "#3b26f6";

        console.log("\n", chalk.hex(color).bold(figlet.textSync("eventsub-gateway", {
            font: "Slant",
            horizontalLayout: "default",
            verticalLayout: "default",
            width: 400,
        })));
        console.log(`   ${chalk.hex(color)("powered by twive.app")}\n`);
    }

    /** key=value pairs; empty values are left out, secrets are masked, long values cut. */
    private formatFields(fields: LogFields): string {
        const parts: string[] = [];
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null || value === "") continue;

            // No JSON in the line: an object (e.g. a condition) adds its entries as fields of their own.
            if (typeof value === "object" && !Array.isArray(value) && !this.errorReporter.isSensitive(key)) {
                const nested: string = this.formatFields(value as LogFields);
                if (nested) parts.push(nested);
                continue;
            }
            parts.push(`${key}=${this.errorReporter.isSensitive(key) ? "***" : this.formatValue(value)}`);
        }
        return parts.join(" ");
    }

    /** A field value: plain if it has no spaces, otherwise quoted; lists comma-separated – control characters escaped. */
    private formatValue(value: unknown): string {
        let text: string;
        if (typeof value === "string") {
            const escaped: string = escapeControl(value);
            text = /[\s"=]/.test(escaped) ? `"${escaped.replaceAll("\"", "'")}"` : escaped;
        } else if (Array.isArray(value)) {
            text = value.map((entry: unknown): string => escapeControl(String(entry))).join(",");
        } else {
            text = String(value);
        }

        return text.length > maxFieldLength ? `${text.slice(0, maxFieldLength)}…` : text;
    }
}
