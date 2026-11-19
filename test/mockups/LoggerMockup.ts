/** One recorded log call. */
export interface LogEntry {
    level: string;
    module: string;
    message: string;
    fields?: Record<string, unknown>;
    error?: unknown;
}

/** A Logger stand-in that records every call instead of printing it. */
export class LoggerMockup {
    public readonly entries: LogEntry[] = [];

    public debug(module: string, message: string, fields?: Record<string, unknown>): void {
        this.entries.push({level: "debug", module, message, fields});
    }

    public info(module: string, message: string, fields?: Record<string, unknown>): void {
        this.entries.push({level: "info", module, message, fields});
    }

    public success(module: string, message: string, fields?: Record<string, unknown>): void {
        this.entries.push({level: "success", module, message, fields});
    }

    public warn(module: string, message: string, fields?: Record<string, unknown>, error?: unknown): void {
        this.entries.push({level: "warn", module, message, fields, error});
    }

    public error(module: string, message: string, fields?: Record<string, unknown>, error?: unknown): void {
        this.entries.push({level: "error", module, message, fields, error});
    }

    public warnThrottled(module: string, message: string, fields?: Record<string, unknown>, error?: unknown): void {
        this.entries.push({level: "warn", module, message, fields, error});
    }

    public spacer(): void {
        // Nothing to record.
    }

    public isDebugEnabled(): boolean {
        return false;
    }

    /** The messages of one level, in order. */
    public messages(level: string): string[] {
        return this.entries.filter((entry: LogEntry): boolean => entry.level === level).map((entry: LogEntry): string => entry.message);
    }
}
