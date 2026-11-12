# Codebase Structure

This document outlines the structure of the project's codebase: the organization of directories and files, the naming
rule and the conventions every contribution has to follow. Formatting is checked by ESLint (`bun run lint:check`),
the workflow is described in the
[Contributing Guide](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CONTRIBUTING.md).

**NOTE**: This document is intended for contributors and maintainers of the project to ensure consistency and clarity
in the codebase. When you change the structure or one of the rules below, update it in the same pull request.

## Directory and Files

```
src/
├── index.ts                                 entry point: bean imports in startup order, CLI (healthcheck, --version), Main
├── core/                                    framework & infrastructure – knows no feature
│   ├── bean/BeanManager.ts                  bean registry, lifecycle, routes, crons, shutdown hooks
│   ├── bean/BeanDecorators.ts               @Bean @Autowired @PostConstruct @MainClass @Route @Cron @ShutdownHook
│   ├── process/ProcessManager.ts            signals, unhandled errors, graceful shutdown and exit
│   ├── config/ConfigManager.ts              environment variables + defaults, validated with zod
│   ├── error/ErrorReporter.ts               log and redact errors (+ MainError)
│   ├── http/HttpClient.ts                   fetch wrapper (+ HttpError)
│   ├── http/HttpProxyService.ts             client address behind trusted proxies (TRUSTED_PROXIES, X-Forwarded-For)
│   ├── http/HttpServer.ts                   Bun.serve for every @Route
│   ├── logging/Logger.ts                    console logging per LogModule
│   ├── redis/RedisClient.ts                 Bun's Redis client with JSON + zod and transactions
│   └── redis/RedisKeys.ts                   every Redis key builder
├── twitch/                                  everything that talks to Twitch
│   ├── TwitchClient.ts                      every Helix/OAuth call
│   ├── app/                                 AppStore, AppAuthenticator, AppSetupService, AppCleanupService
│   └── eventsub/                            EventSubWebhookController, EventSubWebhookStore, EventSubMessageHandler,
│                                            EventSubConduitManager, EventSubSubscriptionManager, EventSubScopeService
├── gateway/                                 the WebSocket gateway
│   ├── GatewayProtocol.ts                   opcodes, close codes, dispatch events, payload types
│   ├── GatewayServer.ts                     WebSocket server
│   ├── GatewayHandler.ts                    IDENTIFY, RESUME, HEARTBEAT
│   ├── connection/                          ConnectionStore (Redis), ConnectionRegistry (sockets, timeouts),
│   │                                        ConnectionLimitManager (connection and auth failure limits per address)
│   └── session/                             SessionStore (Redis), SessionDispatcher
└── health/
    ├── HealthCheckService.ts                the one health check: Redis PING + latency, gateway listening, stats
    ├── HealthController.ts                  GET /health (200 ok / 503 degraded)
    └── HealthPushService.ts                 optional heartbeat push to HEALTH_PUSH_URL (push monitors)
```

`src/index.ts` imports every bean file **in startup order** (core → twitch → gateway → health), then handles the CLI commands,
then declares `Main` with `@MainClass()`, which starts the lifecycle. A new bean file must be added to these imports.

## Naming Conventions

**File name = class name = folder prefix + optional subject + role suffix.**

```
gateway/session/SessionStore.ts              prefix Session, suffix Store
twitch/eventsub/EventSubConduitManager.ts    prefix EventSub, subject Conduit, suffix Manager
twitch/TwitchClient.ts                       files directly in a feature folder carry the feature name
```

- Folders are **singular and lower case** (`session`, `connection`, `app`).
- The prefix is the folder name in PascalCase (`eventsub` → `EventSub`, `http` → `Http`).
- No camelCase files – functions and constants belong in a class or in an exported object named like the file
  (`RedisKeys`, `GatewayProtocol`). Types and zod schemas are exported next to the class they belong to.
- Up to ~400 lines per file – merge what belongs together, split by role when a file outgrows that.

| Suffix | Role | Examples |
|---|---|---|
| `…Controller` | HTTP endpoints (`@Route`) – read the request, delegate, build the response | `HealthController`, `EventSubWebhookController` |
| `…Server` | Owns a listening socket (`Bun.serve`) | `HttpServer`, `GatewayServer` |
| `…Client` | Wrapper around an external system, no business logic | `RedisClient`, `TwitchClient` |
| `…Store` | The only owner of its Redis keys | `SessionStore`, `AppStore` |
| `…Manager` | Owns the lifecycle of a resource: create, reuse, sync, restore | `ConfigManager`, `EventSubConduitManager` |
| `…Service` | Business logic / orchestration without an own resource | `AppSetupService` |
| `…Handler` | Handles the incoming messages of a protocol – one method per message type | `GatewayHandler` (opcodes), `EventSubMessageHandler` (notifications, revocations) |
| `…Authenticator` | Verifies credentials, issues and renews tokens | `AppAuthenticator` |

### Where does new code go?

| I want … | Here |
|---|---|
| a new HTTP endpoint | a `@Route` in a `<Prefix>…Controller` of the feature folder |
| a new Redis key | a builder in `core/redis/RedisKeys.ts`, the `…Store` that owns it and the [key tree](#redis) |
| a new Twitch API call | a method in `twitch/TwitchClient.ts` |
| a new EventSub type / scope | see [EventSub](#eventsub) |
| a recurring job | a `@Cron(...)` method on the bean that owns the job |
| a new config option | see [Contributing Guide](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CONTRIBUTING.md#adding-a-configuration-option) |
| a new feature | a new singular folder in `src/` (`src/clip/`) with files like `ClipStore.ts`, `ClipController.ts` |

## Dependency Rules

- `core` imports nothing from `twitch`, `gateway` or `health`.
- Between the feature folders (`twitch`, `gateway`, `health`) only `import type` + `@Autowired` – this keeps the module graph free of cycles.
  `gateway/GatewayProtocol.ts` is the exception: it may be imported from anywhere.
- **Redis only in `…Store` classes**, **Twitch HTTP only in `TwitchClient`**, `process.env` only in `ConfigManager`.
- Events reach clients only through `SessionDispatcher.dispatch(clientId, eventName, data)`.

## Beans

Every class with state or behavior is a bean of the small dependency injection container in `src/core/bean/`:

```ts
import {Autowired, Bean, PostConstruct} from "@core/bean/BeanDecorators.ts";
import type {SessionStore} from "@gateway/session/SessionStore.ts";

@Bean()
export class SessionExampleService {
    @Autowired()
    private sessionStore!: SessionStore; // property name = class name in camelCase

    @PostConstruct()
    public async initialize(): Promise<void> {
        // runs once all modules are loaded – other beans are available here, not in the constructor
    }
}
```

| Decorator | Effect |
|---|---|
| `@Bean()` | creates the class once and registers it under its class name |
| `@Autowired()` | injects another bean – property name = class name in camelCase, import it with `import type` |
| `@PostConstruct()` | runs after all modules are loaded, in import order; must never block forever |
| `@Route(method, path)` | HTTP route served by `HttpServer` |
| `@Cron(cronTime)` | recurring job, seconds allowed (`*/5 * * * * *`) – the only way to schedule recurring work |
| `@ShutdownHook(order)` | runs on SIGINT/SIGTERM, lowest order first (`ProcessManager` catches the signal, `BeanManager.runShutdownHooks()` stops the crons and runs the hooks, then `ProcessManager` exits). `ProcessManager` is a bean without `@PostConstruct`; `@MainClass` calls its `install()` before every `@PostConstruct` |

**Constructors stay free of side effects** – the CLI commands load every module without starting the lifecycle.

## Types and Exports

Everything that can carry a type annotation has one, even where TypeScript could infer it:

```ts
const port: number = 3000;                       // not: const port = 3000;
const {clientId, secret}: Credentials = data;    // not: const {clientId, secret} = data;
private isShuttingDown: boolean = false;         // not: private isShuttingDown = false;
ids.map((id: string): string => id.trim());      // not: ids.map((id) => id.trim());
```

Exceptions: loop variables of `for…of`/`for…in`, `catch (error)`, zod schemas (named `…Schema`) and objects with
`as const`/`satisfies`. Never use `eslint-disable`.

- `export` only what another file imports; delete what is used nowhere.
- `public` only for members used outside the class (other beans or the container); everything else is `private`.

## Logging and Errors

Every log line belongs to the most specific module of `LogModule` (`src/core/logging/Logger.ts`):

| Module | For | Module | For |
|---|---|---|---|
| `SYSTEM` | startup, shutdown, lifecycle | `CONDUIT` | conduits and shards |
| `HTTP` | HTTP server and routes | `GATEWAY` | WebSocket server |
| `REDIS` | Redis connection | `CONNECTION` | connections, heartbeats, timeouts |
| `AUTH` | credentials, tokens, IDENTIFY/RESUME auth | `SESSION` | sessions |
| `WEBHOOK` | incoming EventSub webhooks | `DISPATCH` | dispatching events |
| `EVENTSUB` | subscriptions, notifications | | |

- Messages per request or event use `debug`. A new area gets its own module.
- **Latency:** on the hot path (webhook → socket), forward first – bookkeeping (Helix calls, logging) runs after the
  dispatch.
- Errors: a readable `this.logger.error(...)` plus `this.errorReporter.handle(error, context)` – it redacts secrets.
  Own errors are thrown as `MainError("MACHINE_CODE", "message")`.
- **Never log or store client secrets or tokens in plain text.**

## Redis

Redis is the only datastore. One instance per Redis database. All state lives in Redis so a restarted instance can
continue; only the sockets (`ConnectionRegistry`) live in memory.

```
twitch:apps:index                                       SET     all client ids                   AppStore
twitch:apps:<clientId>:app                              JSON    App (conduit, bot user, flags)   AppStore
twitch:apps:<clientId>:token                            JSON    app access token (TTL)           AppStore
twitch:apps:<clientId>:users                            SET     authorized user ids              AppStore
twitch:eventsub:messages:<messageId>                    STRING  webhook de-duplication (TTL)     EventSubWebhookStore

gateway:apps:<clientId>:sessions:index                  SET     session ids of the app           SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:session    JSON    session                          SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:seq        STRING  sequence number                  SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:buffer     LIST    replay buffer                    SessionStore
gateway:apps:<clientId>:connections:<connectionId>      JSON    identified connection            ConnectionStore
gateway:pending:<connectionId>                          JSON    before IDENTIFY/RESUME           ConnectionStore
gateway:ratelimit:<connectionId>                        STRING  rate limit counter               ConnectionStore
```

- `twitch:*` only from `src/twitch/`, `gateway:*` only from `src/gateway/`, a key is never the prefix of another key
  (sets are `…:index`, records `…:app`/`…:session`). Sessions reference the app only by `clientId`.
- Every key is built with `RedisKeys` – never with a string template. A store never touches another store's keys.
  `RedisKeys` also puts the optional `REDIS_KEY_PREFIX` in front (`<prefix>:twitch:…`), so no other code knows it.
- Closing a connection detaches/destroys its session only while the session still points to it (Lua) – after a
  RESUME on another connection the old one must not touch it.
- **Never send `MULTI`/`EXEC`** – Bun shares one connection between all callers. Use `redisClient.transaction(...)`,
  `pipeline(...)` or a Lua script via `evalScript()`.

## EventSub

Types and endpoints come from [`twitch-dev-types`](https://github.com/twive-app/twitch-dev-types) – add missing
ones there instead of declaring them locally. To support a new subscription type or scope:

1. Add a row to `scopeRules` in `twitch/eventsub/EventSubScopeService.ts` for the scope(s) Twitch requires (see the
   [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)).
2. Pick the version deliberately – a version bump is a breaking change for clients.
3. Special handling goes into `EventSubMessageHandler`. Nothing to do for a new Twitch event otherwise – every EventSub type
   is forwarded automatically (`channel.chat.message` → `CHANNEL_CHAT_MESSAGE`).

Subscriptions are compared by **type + version + condition**, never by type alone.
