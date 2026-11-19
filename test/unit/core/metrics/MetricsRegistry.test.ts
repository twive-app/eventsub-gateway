import {describe, expect, test} from "bun:test";
import {MetricsRegistry} from "@core/metrics/MetricsRegistry.ts";

describe("MetricsRegistry", (): void => {
    test("counts per label set, the order of the labels doesn't matter", (): void => {
        const metrics: MetricsRegistry = new MetricsRegistry();
        metrics.increment("webhook_messages", "Webhook requests", {type: "notification", result: "accepted"});
        metrics.increment("webhook_messages", "Webhook requests", {result: "accepted", type: "notification"});
        metrics.increment("webhook_messages", "Webhook requests", {type: "notification", result: "duplicate"}, 3);

        expect(metrics.get("webhook_messages", {type: "notification", result: "accepted"})).toBe(2);
        expect(metrics.get("webhook_messages", {type: "notification", result: "duplicate"})).toBe(3);
        expect(metrics.get("webhook_messages", {type: "revocation", result: "accepted"})).toBe(0);
    });

    test("renders the Prometheus text format: gauges first, then the counters with _total", (): void => {
        const metrics: MetricsRegistry = new MetricsRegistry();
        metrics.increment("events_dispatched", "Events dispatched", {event: "CHANNEL_CHEER"});

        const text: string = metrics.render([
            metrics.gauge("connections", "Open connections", [{value: 3}]),
            metrics.gauge("sessions", "Sessions", []),
        ]);

        expect(text).toBe([
            "# HELP eventsub_gateway_connections Open connections",
            "# TYPE eventsub_gateway_connections gauge",
            "eventsub_gateway_connections 3",
            "# HELP eventsub_gateway_events_dispatched_total Events dispatched",
            "# TYPE eventsub_gateway_events_dispatched_total counter",
            "eventsub_gateway_events_dispatched_total{event=\"CHANNEL_CHEER\"} 1",
            "",
        ].join("\n"));
    });

    test("label values are escaped", (): void => {
        const metrics: MetricsRegistry = new MetricsRegistry();
        metrics.increment("test", "Test", {value: "a\"b\\c\nd"});

        expect(metrics.render([])).toContain("eventsub_gateway_test_total{value=\"a\\\"b\\\\c\\nd\"} 1");
    });
});
