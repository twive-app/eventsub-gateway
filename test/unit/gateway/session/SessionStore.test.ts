import {describe, expect, test} from "bun:test";
import {GatewayOpCode, type GatewayPayload} from "@gateway/GatewayProtocol.ts";
import {SessionStore} from "@gateway/session/SessionStore.ts";
import type {ConfigValues} from "@core/config/ConfigManager.ts";
import {loadConfig} from "../../../helpers.ts";

/** Buffered dispatches with these sequence numbers. */
function buffer(...sequences: number[]): GatewayPayload[] {
    return sequences.map((s: number): GatewayPayload => ({op: GatewayOpCode.Dispatch, d: null, s, t: "STREAM_ONLINE"}));
}

describe("SessionStore.getReplay", (): void => {
    test("replays everything after the client's seq", (): void => {
        expect(SessionStore.getReplay(buffer(3, 4, 5), 3, 5)?.map((payload: GatewayPayload): number | null => payload.s)).toEqual([4, 5]);
    });

    test("nothing to replay when the client is up to date", (): void => {
        expect(SessionStore.getReplay(buffer(3, 4, 5), 5, 5)).toEqual([]);
        expect(SessionStore.getReplay([], 0, 0)).toEqual([]);
    });

    test("null when the buffer no longer reaches back to seq", (): void => {
        expect(SessionStore.getReplay(buffer(10, 11), 5, 11)).toBeNull();
    });

    test("null when the session sent events the buffer lost", (): void => {
        expect(SessionStore.getReplay([], 2, 5)).toBeNull();
    });
});

test("an attached session lives for the resume timeout plus two heartbeats", (): void => {
    const config: ConfigValues = loadConfig({GATEWAY_RESUME_TIMEOUT: "120000", GATEWAY_HEARTBEAT_INTERVAL: "41250"});
    expect(SessionStore.attachedTtlMs(config.gateway)).toBe(120000 + 2 * 41250);
});
