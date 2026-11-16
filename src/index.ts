// Entry point: the CLI commands run first and load nothing of the gateway – only starting it imports Main and every bean.
import packageJson from "../package.json";

/** Host and port of the HTTP server, read straight from the environment (same defaults as SERVER_HOST/SERVER_PORT). */
function healthTarget(): string {
    const host: string = process.env.SERVER_HOST || "0.0.0.0";
    const port: number = Number(process.env.SERVER_PORT) || 3000;

    // A wildcard bind address isn't reachable as a target, use loopback.
    const target: string = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${target.includes(":") ? `[${target}]` : target}:${port}/health`;
}

/** `gateway healthcheck`: asks GET /health of the running gateway, exit code 0 = healthy (Docker HEALTHCHECK). */
async function runHealthcheck(): Promise<number> {
    try {
        const response: Response = await fetch(healthTarget(), {signal: AbortSignal.timeout(3000)});
        await response.body?.cancel();
        if (response.status === 200) return 0;

        console.error(`GET /health answered ${response.status}`);
    } catch (error) {
        console.error(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
}

const command: string | undefined = process.argv[2];

if (command === "healthcheck") process.exit(await runHealthcheck());

if (command === "--version") {
    console.log(packageJson.version);
    process.exit(0);
}

if (command !== undefined) {
    console.error(`Unknown command ${command}. Usage: gateway [healthcheck | --version]`);
    process.exit(1);
}

// Only now: every bean file in startup order and Main, which starts the lifecycle.
await import("./Main.ts");
