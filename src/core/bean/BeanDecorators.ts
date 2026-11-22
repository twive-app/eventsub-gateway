import type {Logger} from "@core/logging/Logger.ts";
import {
    BeanManager,
    type HealthCheckHandler,
    type DefaultHandler,
    type RouteHandler,
    type RouteHttpMethod,
} from "@core/bean/BeanManager.ts";
import type {ProcessManager} from "@core/process/ProcessManager.ts";

type Constructor<T = object> = new (...args: never[]) => T;

type ClassDecoratorFn = (target: Constructor) => void;
type MethodDecoratorFn = (target: object, propertyKey: string, descriptor: PropertyDescriptor) => void;
type PropertyDecoratorFn = (target: object, propertyKey: string) => void;

/** Bean token of the class a decorated member belongs to (the upper-cased class name). */
function classTokenOf(target: object): string {
    return target.constructor.name.toUpperCase();
}

/** Creates the class once at module load and registers it as a bean (token = class name). */
export function Bean(token?: string): ClassDecoratorFn {
    return function (target: Constructor): void {
        const key: string = token ?? target.name;
        BeanManager.registerBean(key, new target());
    };
}

/** Injects a bean lazily on first access – the property name is the bean token. */
export function Autowired(token?: string): PropertyDecoratorFn {
    return function (target: object, propertyKey: string): void {
        const key: string = token ?? propertyKey;

        Object.defineProperty(target.constructor.prototype, propertyKey, {
            get(): unknown {
                const bean: unknown = BeanManager.getBean(key);

                // Replace the getter with the resolved bean so later accesses skip the lookup.
                Object.defineProperty(this, propertyKey, {
                    value: bean,
                    writable: false,
                    enumerable: true,
                    configurable: false,
                });
                return bean;
            },
            configurable: true,
            enumerable: true,
        });
    };
}

/** Runs the method once all modules are loaded, in import order and awaited. */
export function PostConstruct(): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addPostConstruct({
            classToken: classTokenOf(target),
            methodName: propertyKey,
            handler: descriptor.value as DefaultHandler,
        });
    };
}

/** Entry point: registers the class, installs the process handlers and starts the lifecycle. */
export function MainClass(token?: string): ClassDecoratorFn {
    return function (target: Constructor): void {
        const key: string = token ?? target.name;
        const instance: object = new target();

        BeanManager.registerBean(key, instance);
        BeanManager.triggerGetters(key.toUpperCase(), instance);

        // Handlers first, so a signal during a slow @PostConstruct still shuts down cleanly.
        const processManager: ProcessManager = BeanManager.getBean<ProcessManager>("ProcessManager");
        processManager.install();
        BeanManager.afterStart().then((): void => {
            (instance as {onStarted?: () => void}).onStarted?.();
        }).catch((error: unknown): void => {
            // Through the shutdown hooks, so what already started (Redis, the other server) is closed properly.
            BeanManager.getBean<Logger>("Logger").error("SYSTEM", "Startup failed", undefined, error);
            void processManager.shutdown("startup failed", 1);
        });
    };
}

/** Serves the method as an HTTP route of HttpServer. */
export function Route(method: RouteHttpMethod, path: string): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addRoute({
            classToken: classTokenOf(target),
            methodName: propertyKey,
            httpMethod: method,
            path,
            handler: descriptor.value as RouteHandler,
        });
    };
}

/** Runs the method on a cron schedule (seconds allowed); errors are reported, never thrown. */
export function Cron(cronTime: string): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addCron({
            classToken: classTokenOf(target),
            methodName: propertyKey,
            cronTime,
            handler: descriptor.value as DefaultHandler,
        });
    };
}

/** Runs the method when the process shuts down (SIGINT/SIGTERM, a failed startup, an uncaught exception), lowest order first. */
export function ShutdownHook(order: number = 50): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addShutdownHook({
            classToken: classTokenOf(target),
            methodName: propertyKey,
            order,
            handler: descriptor.value as DefaultHandler,
        });
    };
}

/** Adds the method to GET /health (and the health push): a result that isn't `ok` makes the gateway degraded. */
export function HealthCheck(name: string): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addHealthCheck({
            classToken: classTokenOf(target),
            methodName: propertyKey,
            name,
            handler: descriptor.value as HealthCheckHandler,
        });
    };
}

/** Runs the method once, as soon as Redis is reachable for the first time – not again after a reconnect. */
export function OnRedisReady(): MethodDecoratorFn {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor): void {
        BeanManager.addListener({
            event: "redis:ready",
            classToken: classTokenOf(target),
            methodName: propertyKey,
            handler: descriptor.value as DefaultHandler,
        });
    };
}
