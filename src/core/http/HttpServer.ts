import type {BunRequest, Server} from "bun";
import {Bean, Autowired, PostConstruct, ShutdownHook} from "@core/bean/BeanDecorators.ts";
import {BeanManager, type RouteHttpMethod, type ServerRoute} from "@core/bean/BeanManager.ts";
import type {ConfigManager, ConfigValues} from "@core/config/ConfigManager.ts";
import {MainError} from "@core/error/ErrorReporter.ts";
import {HttpErrorResponse} from "@core/http/HttpErrorResponse.ts";
import type {Logger} from "@core/logging/Logger.ts";
import type {ProxyService, RemoteAddress} from "@core/proxy/ProxyService.ts";

type MethodHandlers = Partial<Record<RouteHttpMethod, (request: BunRequest, server: Server<undefined>) => Promise<Response>>>;

// Webhook payloads are small – larger bodies are rejected with 413 before anything is read.
const maxRequestBodySize: number = 1024 * 1024;

/** HTTP server (Bun.serve) for every @Route: webhook callback, /twitch/subscriptions, /health and /metrics. */
@Bean()
export class HttpServer {
    @Autowired()
    private configManager!: ConfigManager;

    @Autowired()
    private proxyService!: ProxyService;

    @Autowired()
    private logger!: Logger;

    private server: Server<undefined> | null = null;

    /** Starts the server with all @Route methods; a port that is in use stops the startup. */
    @PostConstruct()
    public start(): void {
        const {host: hostname, port}: ConfigValues["server"] = this.configManager.get().server;

        const routes: Record<string, MethodHandlers> = {};
        for (const route of BeanManager.getServerRoutes()) {
            routes[route.path] ??= {};
            routes[route.path][route.httpMethod] = (request: BunRequest, server: Server<undefined>): Promise<Response> =>
                this.handle(route, request, server);
        }

        try {
            this.server = Bun.serve({
                port,
                hostname,
                maxRequestBodySize,
                routes,
                fetch: (request: Request): Response => this.notFound(request),
            });
            this.logger.success("HTTP", "Listening (webhook, subscriptions, health, metrics)", {port});
        } catch (error) {
            // The startup stops (see @MainClass) – with the shutdown hooks, so nothing stays open.
            this.logger.error("HTTP", "Could not start the HTTP server", {port}, error);
            throw new MainError("STARTUP_FAILED", "The HTTP server could not start");
        }
    }

    /** Stops accepting requests on shutdown. */
    @ShutdownHook(20)
    public async stop(): Promise<void> {
        this.logger.info("HTTP", "Closing the HTTP server");
        await this.server?.stop();
    }

    /** Runs a route handler – logs the request, turns errors into 413 or 500 responses. */
    private async handle(route: ServerRoute, request: BunRequest, server: Server<undefined>): Promise<Response> {
        const path: string = new URL(request.url).pathname;
        const {address, socketAddress}: RemoteAddress = this.proxyService.resolve(request, server);
        if (this.logger.isDebugEnabled()) {
            this.logger.debug("HTTP", `${request.method} ${path}`, {
                ip: address,
                via: address === socketAddress ? undefined : socketAddress,
            });
        }

        try {
            return await route.handler(request, {remoteAddress: address});
        } catch (error) {
            if (error instanceof Error && error.message.includes("maxRequestBodySize")) {
                this.logger.debug("HTTP", `${request.method} ${path} rejected: body too large`, {
                    ip: address,
                });
                return HttpErrorResponse.format(413, "Payload Too Large");
            }

            this.logger.error("HTTP", `${request.method} ${path} failed`, {
                route: route.name,
            }, error);
            return HttpErrorResponse.format(500, "Internal Server Error");
        }
    }

    /** JSON 404 for unknown routes. */
    private notFound(request: Request): Response {
        const path: string = new URL(request.url).pathname;
        return HttpErrorResponse.format(404, "Not Found", `Route ${request.method}:${path} not found`);
    }
}
