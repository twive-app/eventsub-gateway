import {Bean} from "@core/bean/BeanDecorators.ts";

/** Label names and values of one series – only values from a fixed set, never client input (cardinality). */
export type MetricLabels = Record<string, string>;

/** One metric for the exposition: its series with their labels and values. */
export interface MetricFamily {
    name: string;
    help: string;
    type: "counter" | "gauge";
    series: {labels: MetricLabels; value: number}[];
}

// Every metric name starts with it, so the gateway's series are easy to find.
const metricPrefix: string = "eventsub_gateway_";

/** Escapes a label value for the text format: backslash, double quote and line break. */
function escapeLabel(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

/** `{a="1",b="2"}` sorted by name, or nothing without labels. */
function formatLabels(labels: MetricLabels): string {
    const entries: [string, string][] = Object.entries(labels).sort(([a]: [string, string], [b]: [string, string]): number => a.localeCompare(b));
    if (entries.length === 0) return "";
    return `{${entries.map(([name, value]: [string, string]): string => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

/**
 * The counters of the gateway in memory (since the start) and their Prometheus text format – the gauges are read
 * when GET /metrics is scraped (see HealthMetricsController).
 */
@Bean()
export class MetricsRegistry {
    private readonly counters: Map<string, MetricFamily> = new Map<string, MetricFamily>();

    /** Counts something that happened; the name without prefix and `_total`, e.g. ("webhook_messages", …). */
    public increment(name: string, help: string, labels: MetricLabels = {}, by: number = 1): void {
        const fullName: string = `${metricPrefix}${name}_total`;
        let family: MetricFamily | undefined = this.counters.get(fullName);
        if (!family) {
            family = {name: fullName, help, type: "counter", series: []};
            this.counters.set(fullName, family);
        }

        const key: string = formatLabels(labels);
        const series: {labels: MetricLabels; value: number} | undefined = family.series.find((entry: {labels: MetricLabels}): boolean => formatLabels(entry.labels) === key);
        if (series) series.value += by;
        else family.series.push({labels, value: by});
    }

    /** The current value of a counter series, 0 if it never happened (for tests and checks). */
    public get(name: string, labels: MetricLabels = {}): number {
        const key: string = formatLabels(labels);
        return this.counters.get(`${metricPrefix}${name}_total`)?.series.find((entry: {labels: MetricLabels}): boolean => formatLabels(entry.labels) === key)?.value ?? 0;
    }

    /** A gauge for render(): the name without prefix, e.g. ("connections", …). */
    public gauge(name: string, help: string, series: {labels?: MetricLabels; value: number}[]): MetricFamily {
        return {name: `${metricPrefix}${name}`, help, type: "gauge", series: series.map((entry: {labels?: MetricLabels; value: number}): {labels: MetricLabels; value: number} => ({labels: entry.labels ?? {}, value: entry.value}))};
    }

    /** Prometheus text format (version 0.0.4) of the given gauges and every counter. */
    public render(gauges: MetricFamily[]): string {
        const lines: string[] = [];
        for (const family of [...gauges, ...this.counters.values()]) {
            if (family.series.length === 0) continue;

            lines.push(`# HELP ${family.name} ${family.help.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`, `# TYPE ${family.name} ${family.type}`);
            for (const series of family.series) lines.push(`${family.name}${formatLabels(series.labels)} ${series.value}`);
        }
        return `${lines.join("\n")}\n`;
    }
}
