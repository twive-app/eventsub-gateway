import type {ZodSafeParseResult, ZodType} from "zod";
import {BeanManager, type BoundHandler} from "@core/bean/BeanManager.ts";
import {GatewayOpCode} from "@gateway/GatewayProtocol.ts";
import type {LocalConnection} from "@gateway/connection/ConnectionRegistry.ts";

type MethodDecoratorFn = (target: object, propertyKey: string, descriptor: PropertyDescriptor) => void;

// The handler table of the client opcodes in the BeanManager.
const opCodeTable: string = "opcode";

/** What became of a client payload: handled, an opcode without a handler, or `d` that doesn't fit its schema. */
export type GatewayOpCodeResult = "handled" | "unknown" | "invalid";

/**
 * Handles a client opcode – the WebSocket counterpart of @Route, registered in the BeanManager. GatewayServer validates
 * `d` with the schema and calls the method with the connection and `d`; an opcode without a method is closed with
 * 4001, an invalid `d` with 4002. Every opcode once.
 */
export function OpCode(op: GatewayOpCode, schema: ZodType): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addHandler({
            table: opCodeTable,
            key: String(op),
            classToken: target.constructor.name.toUpperCase(),
            methodName: propertyKey,
            handler: descriptor.value as (...args: never[]) => unknown,
            meta: schema,
        });
    };
}

/** Routing of client payloads to the @OpCode methods, for GatewayServer. */
export const GatewayBeanDecorators = {
    /** Validates `d` and runs the @OpCode method of the opcode. */
    async route(connection: LocalConnection, op: number, data: unknown): Promise<GatewayOpCodeResult> {
        const handler: BoundHandler<ZodType> | undefined = BeanManager.getHandler<ZodType>(opCodeTable, String(op));
        if (!handler) return "unknown";

        const parsed: ZodSafeParseResult<unknown> = handler.meta.safeParse(data);
        if (!parsed.success) return "invalid";

        await handler.call(connection, parsed.data);
        return "handled";
    },

    /** The name of an opcode for close reasons ("IDENTIFY"). */
    nameOf(op: number): string {
        return (GatewayOpCode[op] as string | undefined)?.toUpperCase() ?? String(op);
    },
} as const;
