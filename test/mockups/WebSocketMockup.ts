import type {ServerWebSocket} from "bun";
import type {GatewayPayload} from "@gateway/GatewayProtocol.ts";
import type {SocketData} from "@gateway/connection/ConnectionRegistry.ts";

const open: number = 1;
const closed: number = 3;

/** A ServerWebSocket stand-in for the ConnectionRegistry: records the frames it is sent and how it was closed. */
export class WebSocketMockup {
    public readonly frames: GatewayPayload[] = [];
    public readonly data: SocketData;
    public readyState: number = open;
    public closed: {code: number; reason: string} | null = null;

    public constructor(connectionId: string, remoteAddress: string = "203.0.113.5") {
        this.data = {connectionId, remoteAddress, socketAddress: remoteAddress, rejection: null};
    }

    public send(frame: string): number {
        this.frames.push(JSON.parse(frame) as GatewayPayload);
        return frame.length;
    }

    public close(code: number, reason: string): void {
        this.closed = {code, reason};
        this.readyState = closed;
    }

    /** The frames as "EVENT#seq" (or "op N" without an event name). */
    public summary(): string[] {
        return this.frames.map((frame: GatewayPayload): string => frame.t ? `${frame.t}#${frame.s ?? "-"}` : `op ${frame.op}`);
    }

    /** Typed for ConnectionRegistry.add(). */
    public asSocket(): ServerWebSocket<SocketData> {
        return this as unknown as ServerWebSocket<SocketData>;
    }
}
