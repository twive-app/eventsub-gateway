import type {BunRequest} from "bun";
import {Cron as CronJob} from "croner";
import type {Logger} from "@core/logging/Logger.ts";

export type LifecycleHandler = () => void | Promise<void>;

interface PostConstructorDefinition {
    classToken: string;
    methodName: string;
    handler: LifecycleHandler;
}

export type RouteHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** What a route gets besides the request: the client address (X-Forwarded-For only from trusted proxies). */
export interface RouteContext {
    remoteAddress: string;
}

export type RouteHandler = (request: BunRequest, context: RouteContext) => Response | Promise<Response>;

export interface ServerRoute {
    name: string;
    httpMethod: RouteHttpMethod;
    path: string;
    handler: RouteHandler;
}

interface RouteDefinition {
    classToken: string;
    methodName: string;
    httpMethod: RouteHttpMethod;
    path: string;
    handler: RouteHandler;
}

interface CronDefinition {
    classToken: string;
    methodName: string;
    cronTime: string;
    handler: LifecycleHandler;
}

interface ShutdownHookDefinition {
    classToken: string;
    methodName: string;
    order: number;
    handler: LifecycleHandler;
}

/** A shutdown hook, bound to its bean. */
interface BoundShutdownHook {
    name: string;
    hook: LifecycleHandler;
}

/** Result of a @HealthCheck method: `ok`, why not (`failure`), and details for the body of GET /health. */
export interface HealthCheckResult {
    ok: boolean;
    failure?: string;
    details?: Record<string, unknown>;
}

export type HealthCheckHandler = () => HealthCheckResult | Promise<HealthCheckResult>;

/** A @HealthCheck method, bound to its bean. */
export interface ServerHealthCheck {
    name: string;
    check: HealthCheckHandler;
}

/** A method under a unique key of a feature's handler table (e.g. a client opcode); `meta` belongs to the feature. */
interface HandlerDefinition {
    table: string;
    key: string;
    classToken: string;
    methodName: string;
    handler: (...args: never[]) => unknown;
    meta: unknown;
}

/** A handler of a table, bound to its bean. */
export interface BoundHandler<M> {
    name: string;
    call: (...args: unknown[]) => unknown;
    meta: M;
}

/** A method that runs when an event is emitted (e.g. "redis:ready"). */
interface ListenerDefinition {
    event: string;
    classToken: string;
    methodName: string;
    handler: LifecycleHandler;
}

interface HealthCheckDefinition {
    classToken: string;
    methodName: string;
    name: string;
    handler: HealthCheckHandler;
}

type BeansMap = Map<string, object>;
type PostConstructorsMap = Map<string, PostConstructorDefinition>;

/** Error of the bean container: missing bean, broken getter or invalid cron. */
class BeanError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "BeanError";
    }
}

/** The dependency injection container: bean registry, lifecycle, routes, crons, shutdown hooks, health checks, handler tables and events. */
export class BeanManager {
    private static beansMap: BeansMap = new Map<string, object>();
    private static postConstructors: PostConstructorsMap = new Map<string, PostConstructorDefinition>();
    private static routes: RouteDefinition[] = [];
    private static crons: CronDefinition[] = [];
    private static shutdownHooks: ShutdownHookDefinition[] = [];
    private static healthChecks: HealthCheckDefinition[] = [];
    private static handlerTables: Map<string, Map<string, HandlerDefinition>> = new Map<string, Map<string, HandlerDefinition>>();
    private static listeners: ListenerDefinition[] = [];
    private static scheduledJobs: (() => void)[] = [];

    /** Registers a bean under its token (case-insensitive). */
    public static registerBean(token: string, instance: object): void {
        this.beansMap.set(token.toUpperCase(), instance);
    }

    /** Returns the bean of a token or throws if there is none. */
    public static getBean<T>(token: string): T {
        const key: string = token.toUpperCase();
        const bean: object | undefined = this.beansMap.get(key);

        if (!bean) throw new BeanError(`Bean ${token} not found`);
        return bean as T;
    }

    /** Remembers a @PostConstruct method. */
    public static addPostConstruct(def: PostConstructorDefinition): void {
        this.postConstructors.set(`${def.classToken}.${def.methodName}`, def);
    }

    /** Every @PostConstruct in the order it runs ("HTTPSERVER.start"). */
    public static getPostConstructNames(): string[] {
        return [...this.postConstructors.keys()];
    }

    /** Runs every @PostConstruct in import order, then starts the crons. */
    public static async afterStart(): Promise<void> {
        for (const def of this.postConstructors.values()) {
            const instance: object = this.getBean<object>(def.classToken);
            await def.handler.call(instance);
        }

        this.registerCrons();
    }

    /** Touches every getter once, so a missing @Autowired bean fails at startup and not later. */
    public static triggerGetters(key: string, instance: object): void {
        const prototype: object = Object.getPrototypeOf(instance) as object;
        for (const prop of Object.getOwnPropertyNames(prototype)) {
            const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(prototype, prop);
            if (descriptor?.get) {
                try {
                    void (instance as Record<string, unknown>)[prop];
                } catch (error) {
                    throw new BeanError(`Error triggering getter ${key}.${prop}: ${(error as Error).message}`);
                }
            }
        }
    }

    /** Remembers a @Route method. */
    public static addRoute(def: RouteDefinition): void {
        this.routes.push(def);
    }

    /** All routes, bound to their beans, for HttpServer. */
    public static getServerRoutes(): ServerRoute[] {
        return this.routes.map((route: RouteDefinition): ServerRoute => ({
            name: `${route.classToken}.${route.methodName}`,
            httpMethod: route.httpMethod,
            path: route.path,
            handler: route.handler.bind(this.getBean<object>(route.classToken)),
        }));
    }

    /** Remembers a @Cron method. */
    public static addCron(def: CronDefinition): void {
        this.crons.push(def);
    }

    /** Schedules every @Cron method; `protect` skips a run while the previous one is still running. */
    private static registerCrons(): void {
        for (const cronDef of this.crons) {
            const name: string = `${cronDef.classToken}.${cronDef.methodName}`;
            const run: () => Promise<void> = this.guarded(name, cronDef.handler.bind(this.getBean<object>(cronDef.classToken)));

            try {
                const job: CronJob = new CronJob(cronDef.cronTime, {protect: true}, run);
                this.scheduledJobs.push((): void => {
                    job.stop();
                });
            } catch (error) {
                throw new BeanError(`Error registering cron for ${name}: ${(error as Error).message}`);
            }
        }
    }

    /** Wraps a cron handler so an error is reported instead of crashing the process. */
    private static guarded(name: string, handler: LifecycleHandler): () => Promise<void> {
        return async (): Promise<void> => {
            try {
                await handler();
            } catch (error) {
                this.getBean<Logger>("Logger").error("SYSTEM", "Scheduled job failed", {job: name}, error);
            }
        };
    }

    /** Remembers a method under a key of a handler table – every key once (feature decorators like @OpCode). */
    public static addHandler(def: HandlerDefinition): void {
        let table: Map<string, HandlerDefinition> | undefined = this.handlerTables.get(def.table);
        if (!table) {
            table = new Map<string, HandlerDefinition>();
            this.handlerTables.set(def.table, table);
        }

        const existing: HandlerDefinition | undefined = table.get(def.key);
        if (existing) {
            throw new BeanError(`${def.table} ${def.key} is handled twice: ${existing.classToken}.${existing.methodName} and ${def.classToken}.${def.methodName}`);
        }
        table.set(def.key, def);
    }

    /** The handler of a key, bound to its bean – undefined if nobody handles it. */
    public static getHandler<M>(table: string, key: string): BoundHandler<M> | undefined {
        const def: HandlerDefinition | undefined = this.handlerTables.get(table)?.get(key);
        if (!def) return undefined;

        const instance: object = this.getBean<object>(def.classToken);
        return {
            name: `${def.classToken}.${def.methodName}`,
            call: (...args: unknown[]): unknown => (def.handler as (...values: unknown[]) => unknown).apply(instance, args),
            meta: def.meta as M,
        };
    }

    /** Every key of a handler table with its method ("1 → GATEWAYHANDLER.identify"). */
    public static getHandlerNames(table: string): string[] {
        return [...this.handlerTables.get(table)?.values() ?? []].map((def: HandlerDefinition): string => `${def.key} → ${def.classToken}.${def.methodName}`);
    }

    /** Remembers a method that runs when the event is emitted. */
    public static addListener(def: ListenerDefinition): void {
        this.listeners.push(def);
    }

    /** Runs the listeners of an event in import order, awaited – a failing listener is logged and doesn't stop the others. */
    public static async emit(event: string): Promise<void> {
        for (const def of this.listeners.filter((listener: ListenerDefinition): boolean => listener.event === event)) {
            try {
                await def.handler.call(this.getBean<object>(def.classToken));
            } catch (error) {
                this.getBean<Logger>("Logger").error("SYSTEM", "Event listener failed", {event, listener: `${def.classToken}.${def.methodName}`}, error);
            }
        }
    }

    /** The listeners of an event ("SESSIONSTORE.detachPreviousRun"). */
    public static getListenerNames(event: string): string[] {
        return this.listeners
            .filter((listener: ListenerDefinition): boolean => listener.event === event)
            .map((def: ListenerDefinition): string => `${def.classToken}.${def.methodName}`);
    }

    /** Remembers a @HealthCheck method – every name once. */
    public static addHealthCheck(def: HealthCheckDefinition): void {
        if (this.healthChecks.some((check: HealthCheckDefinition): boolean => check.name === def.name)) {
            throw new BeanError(`Health check ${def.name} is registered twice (${def.classToken}.${def.methodName})`);
        }
        this.healthChecks.push(def);
    }

    /** All health checks in import order, bound to their beans, for HealthCheckService. */
    public static getHealthChecks(): ServerHealthCheck[] {
        return this.healthChecks.map((def: HealthCheckDefinition): ServerHealthCheck => ({
            name: def.name,
            check: def.handler.bind(this.getBean<object>(def.classToken)),
        }));
    }

    /** Remembers a @ShutdownHook method. */
    public static addShutdownHook(def: ShutdownHookDefinition): void {
        this.shutdownHooks.push(def);
    }

    /** Stops the crons, then runs the shutdown hooks by order – a failing hook does not stop the others. */
    public static async runShutdownHooks(): Promise<void> {
        // No cron may start a new run while the gateway shuts down.
        for (const stop of this.scheduledJobs.splice(0)) stop();

        for (const hook of this.getRegisteredShutdownHooks()) {
            try {
                await hook.hook();
            } catch (error) {
                this.getBean<Logger>("Logger").error("SYSTEM", "Shutdown hook failed", {hook: hook.name}, error);
            }
        }
    }

    /** Shutdown hooks sorted by order and bound to their beans. */
    private static getRegisteredShutdownHooks(): BoundShutdownHook[] {
        return [...this.shutdownHooks]
            .sort((a: ShutdownHookDefinition, b: ShutdownHookDefinition): number => a.order - b.order)
            .map((def: ShutdownHookDefinition): BoundShutdownHook => {
                const instance: object = this.getBean<object>(def.classToken);

                return {
                    name: `${def.classToken}.${def.methodName}`,
                    hook: def.handler.bind(instance),
                };
            });
    }
}
