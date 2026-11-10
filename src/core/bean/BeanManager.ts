import type {BunRequest} from "bun";
import {Cron as CronJob} from "croner";
import type {ErrorReporter} from "@core/error/ErrorReporter.ts";
import type {Logger} from "@core/logging/Logger.ts";

export type LifecycleHandler = () => void | Promise<void>;
export type RouteHandler = (request: BunRequest) => Response | Promise<Response>;

interface PostConstructorDefinition {
    classToken: string;
    methodName: string;
    handler: LifecycleHandler;
}

export type RouteHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

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

interface ShutdownHooks {
    name: string;
    hook: LifecycleHandler;
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

/** The dependency injection container: bean registry, lifecycle, routes, crons and shutdown hooks. */
export class BeanManager {
    private static beansMap: BeansMap = new Map<string, object>();
    private static postConstructors: PostConstructorsMap = new Map<string, PostConstructorDefinition>();
    private static routes: RouteDefinition[] = [];
    private static crons: CronDefinition[] = [];
    private static shutdownHooks: ShutdownHookDefinition[] = [];
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
                const errorReporter: ErrorReporter = this.getBean<ErrorReporter>("ErrorReporter");
                errorReporter.log(errorReporter.normalize(error), {job: name});
            }
        };
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
                this.getBean<Logger>("Logger").error("SYSTEM", `Failed executing shutdown hook: ${hook.name}`);
                this.getBean<ErrorReporter>("ErrorReporter").handle(error);
            }
        }
    }

    /** Shutdown hooks sorted by order and bound to their beans. */
    private static getRegisteredShutdownHooks(): ShutdownHooks[] {
        return [...this.shutdownHooks]
            .sort((a: ShutdownHookDefinition, b: ShutdownHookDefinition): number => a.order - b.order)
            .map((def: ShutdownHookDefinition): ShutdownHooks => {
                const instance: object = this.getBean<object>(def.classToken);

                return {
                    name: `${def.classToken}.${def.methodName}`,
                    hook: def.handler.bind(instance),
                };
            });
    }
}
