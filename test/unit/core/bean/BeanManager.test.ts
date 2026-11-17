import {describe, expect, test} from "bun:test";
import "@gateway/session/SessionStore.ts";
import {OnRedisReady} from "@core/bean/BeanDecorators.ts";
import {BeanManager, type BoundHandler} from "@core/bean/BeanManager.ts";
import {provideBean} from "../../../helpers.ts";
import {LoggerMockup} from "../../../mockups/LoggerMockup.ts";

/** A bean with a listener that runs when Redis is reachable. */
class ReadyListener {
    public runs: number = 0;

    @OnRedisReady()
    public onReady(): void {
        this.runs++;
    }
}

/** A bean with a method for a handler table. */
class Greeter {
    public readonly prefix: string = "hi ";

    public greet(name: string): string {
        return this.prefix + name;
    }
}

describe("BeanManager events", (): void => {
    test("SessionStore detaches the sessions of the previous run once Redis is reachable", (): void => {
        expect(BeanManager.getListenerNames("redis:ready")).toContain("SESSIONSTORE.detachPreviousRun");
    });

    test("emit runs the listeners on their beans – a failing one is logged and doesn't stop the others", async (): Promise<void> => {
        const logger: LoggerMockup = new LoggerMockup();
        const listener: ReadyListener = new ReadyListener();
        provideBean("logger", logger);
        provideBean("readyListener", listener);
        // SessionStore's listener fails here – there is no Redis.
        provideBean("sessionStore", {
            detachPreviousRun: (): never => {
                throw new Error("no Redis");
            },
        });

        await BeanManager.emit("redis:ready");

        expect(listener.runs).toBe(1);
        expect(logger.messages("error")).toEqual(["Event listener failed"]);
    });
});

describe("BeanManager handler tables", (): void => {
    test("getHandler binds the method to its bean and carries its meta", (): void => {
        provideBean("greeter", new Greeter());
        BeanManager.addHandler({table: "test", key: "greet", classToken: "GREETER", methodName: "greet", handler: Greeter.prototype.greet, meta: {loud: false}});

        const handler: BoundHandler<{loud: boolean}> | undefined = BeanManager.getHandler<{loud: boolean}>("test", "greet");
        expect(handler?.call("you")).toBe("hi you");
        expect(handler?.meta).toEqual({loud: false});
        expect(BeanManager.getHandler("test", "missing")).toBeUndefined();
    });

    test("a key can only be handled once", (): void => {
        const add: () => void = (): void => BeanManager.addHandler({table: "test", key: "greet", classToken: "OTHER", methodName: "greet", handler: Greeter.prototype.greet, meta: null});
        expect(add).toThrow("test greet is handled twice: GREETER.greet and OTHER.greet");
    });
});
