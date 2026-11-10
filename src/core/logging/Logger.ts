import chalk from "chalk";
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
const defaultOptions: DateFormatterOptions = {
    schema: "dd-MM-yyyy HH:mm:ss",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
};

figlet.parseFont("Slant", slantFont);

/** Console logging with colored level and module; debug lines only with LOG_DEBUG. */
@Bean()
export class Logger {
    @Autowired()
    private configManager!: ConfigManager;

    /** Prints the ASCII art banner on startup. */
    public header(): void {
        const name: string = "twive-gateway";

        console.log("\n", chalk.hex("#3b26f6").bold(figlet.textSync(name, {
            font: "Slant",
            horizontalLayout: "default",
            verticalLayout: "default",
            width: 400,
        })), "\n");
    }

    /** Writes one log line: time, level, module, message (and the context, if any). */
    private logToConsole(level: keyof typeof LogLevel, logModule: keyof typeof LogModule, message: string, context: Record<string, unknown>): void {
        const logLevelColor: LogLevel = LogLevel[level];
        const logModuleColor: LogModule = LogModule[logModule];
        const currentTime: string = Logger.formatDate(new Date(), {
            schema: "dd-MM-yyyy HH:mm:ss",
        });

        console.log(`${currentTime} [${chalk.hex(logLevelColor)(level)}] [${chalk.hex(logModuleColor)(logModule)}] | ${message}`);
        if (Object.keys(context).length > 0) console.log(chalk.hex("#ffffff")("Context: "), context);
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
        if (this.configManager.get().logging.debug) this.logToConsole("DEBUG", logModule, message, context);
    }

    /** Formats a date in the time zone of the process (default schema dd-MM-yyyy HH:mm:ss). */
    public static formatDate(date: Date, options?: DateFormatterOptions): string {
        options = Object.assign({}, defaultOptions, options);

        const targetDate: Date = Logger.convertToTimezone(date, (options.timezone as string));
        switch (options.schema) {
            case "ISO":
                return targetDate.toISOString();
            case "timestamp":
                return targetDate.getTime().toString();
            default:
                return Logger.formatBySchema(targetDate, (options.schema as string));
        }
    }

    /** Replaces the tokens yyyy, MM, dd, HH, mm, ss and SSS of a schema. */
    private static formatBySchema(date: Date, schema: string): string {
        const pad: (n: number) => string = (n: number): string => n.toString().padStart(2, "0");

        const tokens: Record<string, string> = {
            "yyyy": date.getFullYear().toString(),
            "MM": pad(date.getMonth() + 1),
            "dd": pad(date.getDate()),
            "HH": pad(date.getHours()),
            "mm": pad(date.getMinutes()),
            "ss": pad(date.getSeconds()),
            "SSS": date.getMilliseconds().toString().padStart(3, "0"),
        };

        let result: string = schema;
        Object.entries(tokens).forEach(([token, value]: [string, string]): void => {
            result = result.replace(new RegExp(token, "g"), value);
        });
        return result;
    }

    /** The same wall-clock time in another time zone, as a local Date. */
    private static convertToTimezone(date: Date, timezone: string): Date {
        const formatter: Intl.DateTimeFormat = new Intl.DateTimeFormat("de-DE", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });

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
