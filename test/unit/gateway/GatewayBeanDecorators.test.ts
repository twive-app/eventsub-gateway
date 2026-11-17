import {describe, expect, test} from "bun:test";
import z from "zod";
import "@gateway/GatewayHandler.ts";
import {BeanManager} from "@core/bean/BeanManager.ts";
import {GatewayBeanDecorators, OpCode, type GatewayOpCodeResult} from "@gateway/GatewayBeanDecorators.ts";
import {GatewayOpCode} from "@gateway/GatewayProtocol.ts";
import type {LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";
import {provideBean} from "../../helpers.ts";

// An opcode no client sends – only this test handles it.
const echoOp: GatewayOpCode = 99 as GatewayOpCode;
const connection: LocalConnection = {connectionId: "c1"} as LocalConnection;

/** A bean with an @OpCode method, like GatewayHandler. */
class EchoHandler {
    public readonly received: unknown[] = [];

    @OpCode(echoOp, z.object({text: z.string()}))
    public echo(target: LocalConnection, data: {text: string}): void {
        this.received.push({connection: target.connectionId, ...data});
    }
}

describe("@OpCode", (): void => {
    test("GatewayHandler handles HEARTBEAT, IDENTIFY and RESUME", (): void => {
        expect(BeanManager.getHandlerNames("opcode")).toEqual(expect.arrayContaining([
            `${GatewayOpCode.Heartbeat} → GATEWAYHANDLER.heartbeat`,
            `${GatewayOpCode.Identify} → GATEWAYHANDLER.identify`,
            `${GatewayOpCode.Resume} → GATEWAYHANDLER.resume`,
        ]));
    });

    test("a valid d reaches the method of the bean", async (): Promise<void> => {
        const handler: EchoHandler = new EchoHandler();
        provideBean("EchoHandler", handler);

        const result: GatewayOpCodeResult = await GatewayBeanDecorators.route(connection, echoOp, {text: "hi"});
        expect(result).toBe("handled");
        expect(handler.received).toEqual([{connection: "c1", text: "hi"}]);
    });

    test("an invalid d is refused before the method runs", async (): Promise<void> => {
        const handler: EchoHandler = new EchoHandler();
        provideBean("EchoHandler", handler);

        expect(await GatewayBeanDecorators.route(connection, echoOp, {text: 1})).toBe("invalid");
        expect(handler.received).toEqual([]);
    });

    test("an opcode without a method is unknown", async (): Promise<void> => {
        expect(await GatewayBeanDecorators.route(connection, 98, {})).toBe("unknown");
    });

    test("one opcode can't have two methods", (): void => {
        const decorate: () => void = (): void => OpCode(echoOp, z.unknown())({constructor: {name: "Other"}} as object, "handle", {value: (): void => undefined});
        expect(decorate).toThrow("opcode 99 is handled twice: ECHOHANDLER.echo and OTHER.handle");
    });

    test("close reasons name the opcode", (): void => {
        expect(GatewayBeanDecorators.nameOf(GatewayOpCode.Identify)).toBe("IDENTIFY");
    });
});
