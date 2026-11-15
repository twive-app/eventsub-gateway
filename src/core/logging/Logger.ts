import chalk, {type ChalkInstance} from "chalk";
import figlet from "figlet";
import slantFont from "figlet/importable-fonts/Slant.js";
import type {ConfigManager} from "@core/config/ConfigManager.ts";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";

type DateSchema = "dd-MM-yyyy HH:mm:ss" | "ISO" | "timestamp" | string;

interface DateFormatterOptions {
    schema?: DateSchema;
    timezone?: string;
}

// Log timestamps use the time zone of the process (TZ).
const processTimezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
const defaultOptions: DateFormatterOptions = {
    schema: "dd-MM-yyyy HH:mm:ss",
    timezone: processTimezone,
};

// Built once instead of for every log line.
const colorizers: Map<string, ChalkInstance> = new Map<string, ChalkInstance>();
const timezoneFormatters: Map<string, Intl.DateTimeFormat> = new Map<string, Intl.DateTimeFormat>();
const schemaTokens: [RegExp, (date: Date) => string][] = [
    [/yyyy/g, (date: Date): string => date.getFullYear().toString()],
    [/MM/g, (date: Date): string => pad2(date.getMonth() + 1)],
    [/dd/g, (date: Date): string => pad2(date.getDate())],
    [/HH/g, (date: Date): string => pad2(date.getHours())],
    [/mm/g, (date: Date): string => pad2(date.getMinutes())],
    [/ss/g, (date: Date): string => pad2(date.getSeconds())],
    [/SSS/g, (date: Date): string => date.getMilliseconds().toString().padStart(3, "0")],
];

/** Two digits with a leading zero. */
function pad2(value: number): string {
    return value < 10 ? `0${value}` : value.toString();
}

/** A cached chalk color. */
function colorize(hex: string): ChalkInstance {
    let colorizer: ChalkInstance | undefined = colorizers.get(hex);
    if (!colorizer) {
        colorizer = chalk.hex(hex);
        colorizers.set(hex, colorizer);
    }
    return colorizer;
}

figlet.parseFont("Slant", slantFont);

/** Console logging with colored level and module; debug lines only with LOG_DEBUG. */
@Bean()
export class Logger {
    @Autowired()
    private configManager!: ConfigManager;

    // LOG_DEBUG, read on the first debug call – the configuration never changes at runtime.
    private debugEnabled: boolean | null = null;

    /** Prints the ASCII art banner on startup, followed by "powered by twive.app". */
    public header(): void {
        const color: string = "#3b26f6";

        console.log("\n", chalk.hex(color).bold(figlet.textSync("eventsub-gateway", {
            font: "Slant",
            horizontalLayout: "default",
            verticalLayout: "default",
            width: 400,
        })));
        console.log(` ${chalk.hex(color)("powered by twive.app")}\n`);
    }

    /** Writes one log line: time, level, module, message (and the context, if any). */
    private logToConsole(level: keyof typeof LogLevel, logModule: keyof typeof LogModule, message: string, context: Record<string, unknown>): void {
        const currentTime: string = Logger.formatDate(new Date());

        console.log(`${currentTime} [${colorize(LogLevel[level])(level)}] [${colorize(LogModule[logModule])(logModule)}] | ${message}`);
        if (Object.keys(context).length > 0) console.log(colorize("#ffffff")("Context: "), context);
    }

    /** Normal operation, e.g. a session was identified. */
    public info(logModule: keyof typeof LogModule, message: string, context: Record<string, unknown> = {}): void {
        this.logToConsole("INFO", logModule, message, context);
    }

    /** Something unexpected that the gateway handles itself. */
    public warning(logModule: keyof typeof LogModule, message: string, context: Record<string, unknown> = {}): void {
        this.logToConsole("WARNING", logModule, message, context);
    }

    /** Something failed – usually followed by the ErrorReporter output. */
    public error(logModule: keyof typeof LogModule, message: string, context: Record<string, unknown> = {}): void {
        this.logToConsole("ERROR", logModule, message, context);
    }

    /** Something finished successfully, e.g. a server started. */
    public success(logModule: keyof typeof LogModule, message: string, context: Record<string, unknown> = {}): void {
        this.logToConsole("SUCCESS", logModule, message, context);
    }

    /** High-frequency details (every request, event, connection) – only with LOG_DEBUG=true. */
    public debug(logModule: keyof typeof LogModule, message: string, context: Record<string, unknown> = {}): void {
        if (this.isDebugEnabled()) this.logToConsole("DEBUG", logModule, message, context);
    }

    /** Whether debug lines are written – lets hot paths skip building a message nobody sees. */
    public isDebugEnabled(): boolean {
        this.debugEnabled ??= this.configManager.get().logging.debug;
        return this.debugEnabled;
    }

    /** Formats a date in the time zone of the process (default schema dd-MM-yyyy HH:mm:ss). */
    public static formatDate(date: Date, options?: DateFormatterOptions): string {
        options = options ? {...defaultOptions, ...options} : defaultOptions;

        // The process time zone is what Date's local getters already use – no conversion needed.
        const timezone: string = options.timezone as string;
        const targetDate: Date = timezone === processTimezone ? date : Logger.convertToTimezone(date, timezone);
        switch (options.schema) {
            case "ISO":
                return targetDate.toISOString();
            case "timestamp":
                return targetDate.getTime().toString();
            default:
                return Logger.formatBySchema(targetDate, (options.schema as string));
        }
    }

    /** Replaces the tokens yyyy, MM, dd, HH, mm, ss and SSS of a schema – the log schema without any regex. */
    private static formatBySchema(date: Date, schema: string): string {
        if (schema === "dd-MM-yyyy HH:mm:ss") {
            return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
        }

        let result: string = schema;
        for (const [token, value] of schemaTokens) result = result.replace(token, value(date));
        return result;
    }

    /** The same wall-clock time in another time zone, as a local Date. */
    private static convertToTimezone(date: Date, timezone: string): Date {
        let formatter: Intl.DateTimeFormat | undefined = timezoneFormatters.get(timezone);
        if (!formatter) {
            formatter = new Intl.DateTimeFormat("de-DE", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
            timezoneFormatters.set(timezone, formatter);
        }

        const parts: Intl.DateTimeFormatPart[] = formatter.formatToParts(date);
        const values: Record<string, number> = {};

        parts.forEach(({type, value}: Intl.DateTimeFormatPart): void => {
            values[type] = parseInt(value, 10);
        });

        return new Date(
            values.year,
            values.month - 1,
            values.day,
            values.hour,
            values.minute,
            values.second,
        );
    }
}

/** Colors of the log levels. */
enum LogLevel {
    INFO = "#3ae1ff",
    WARNING = "#fca13a",
    ERROR = "#fc3a4a",
    SUCCESS = "#3afc77",
    DEBUG = "#d24cff",
}

/** Modules a log line belongs to, with their colors. */
export enum LogModule {
    SYSTEM = "#3b26f6",
    HTTP = "#b9ff4f",
    REDIS = "#e74c3c",
    AUTH = "#4dabf7",
    WEBHOOK = "#b197fc",
    EVENTSUB = "#9146ff",
    CONDUIT = "#da77f2",
    GATEWAY = "#ffcc5d",
    CONNECTION = "#ffa94d",
    SESSION = "#f783ac",
    DISPATCH = "#63e6be",
}
