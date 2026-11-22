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
├── index.ts           entry point: the CLI commands (healthcheck, --version), then imports Main.ts
├── Main.ts            every bean file in startup order; Main starts the lifecycle
├── core/              framework and infrastructure, knows no feature: bean (the DI container), config, error, http,
│                      logging, metrics, process, proxy, redis
├── twitch/            everything that talks to Twitch – TwitchClient makes every Helix/OAuth call
│   ├── app/           applications: credentials and tokens, setup, bot user, conduit check, token renewal, cleanup
│   └── eventsub/      webhook, conduit, subscriptions (per user and public), scope rules, subscription limit
├── gateway/           the WebSocket gateway: protocol, server, opcode handlers
│   ├── connection/    open sockets, their limits and their state in Redis
│   └── session/       sessions, replay buffer, dispatching events
└── health/            GET /health, the health push, GET /metrics
```

The file names follow the [naming conventions](#naming-conventions) – they say what a class does, and its first
comment says the rest. That's why only the folders are listed here.

`src/index.ts` handles the CLI commands first and imports nothing of the gateway for them – `healthcheck` runs every
30 s in Docker and stays a tiny process. Only to start the gateway it imports `src/Main.ts`, which imports every bean
file **in startup order** (core → twitch → gateway → health) and declares `Main` with `@MainClass()`, which starts the
lifecycle. A new bean file must be added to the imports in `Main.ts`. A value import of a bean file elsewhere loads it
earlier and moves its `@PostConstruct` forward – shared helpers therefore live in files without a bean (e.g.
`HttpErrorResponse`); a test makes sure `HttpServer` still starts last. A failing `@PostConstruct` stops the startup through
`ProcessManager.shutdown()`, so the shutdown hooks close what already started.

## Tests

Tests live in `test/` and run with `bun run test` – without Twitch or network; only the integration tests need a
Redis.

```
test/
├── helpers.ts    loadConfig(), provideBean(); registers a MetricsRegistry every test can count with
├── mockups/      stand-ins: TwitchMockup, RedisClientMockup, GatewayMockup, ConfigManagerMockup, LoggerMockup,
│                 WebSocketMockup
├── unit/         one class at a time, same structure as src/ (unit/twitch/eventsub/EventSubScopeService.test.ts)
├── flows/        the gateway as a whole against TwitchMockup (setup, authorization, public subscriptions, conduit
│                 check, Redis loss, cleanup, subscription limit, metrics)
└── integration/  the Redis code against a real Redis, same structure as src/ – TestRedis.ts connects
```

**Unit tests** (`test/unit/`):

- Test what has rules: scope → subscriptions, validation, signatures, replay, limits, redaction, config parsing.
- A bean gets its dependencies as stand-ins: `provideBean("appStore", {getToken: …})` **before** `new AppStore…()`,
  `@Autowired` then resolves them. `LoggerMockup` records log calls instead of printing them, `ConfigManagerMockup`
  returns a given configuration.
- Configuration only through `loadConfig({VARIABLE: "value"})` – it ignores the local `.env`, so tests behave the same
  everywhere.
- Time-dependent code with `setSystemTime()` from `bun:test`, never real waiting.

**Flows** (`test/flows/`): `TwitchMockup` is Twitch in memory – token, conduits, shards, subscriptions,
authorizations, with Twitch's rules (409 duplicate, 403 without authorization, cost and 429, deleting a conduit deletes
its subscriptions). It replaces `fetch` and sends signed webhooks to the gateway: the shard challenge,
`twitch.authorize()` (grant), `twitch.revoke()`, `twitch.emit()` (notification). `twitch.failNext(route, status)`
injects errors, `twitch.requests` counts calls, `twitch.interruptAfter(route, action)` lets something happen
between two steps of the gateway – how races are reproduced (e.g. a revoke while a restore runs). `GatewayMockup` wires fresh beans against it – everything that talks
to Twitch is real; the stores run on `RedisClientMockup`, dispatches and sessions are recorded.

```ts
const gateway: GatewayMockup = new GatewayMockup();
gateway.twitch.registerApp(clientId, secret);
await gateway.identify(clientId, secret);
await gateway.twitch.authorize(clientId, "111", ["bits:read"]);
await gateway.waitFor((): boolean => gateway.twitch.subscriptionSummary(clientId).includes("channel.cheer 111"));
```

**Integration tests** (`test/integration/`): everything whose correctness lives in Redis – the Lua scripts (dispatch,
detach, heartbeat, `AppStore.removeInactive`), TTLs, optimistic locking and what happens when two calls race. They run
against the Redis in `TEST_REDIS_URL` (e.g. `redis://localhost:6379/15`) and are skipped without it – except in CI,
where a missing URL fails the run. `TestRedis` gives every test file its own random `REDIS_KEY_PREFIX` and deletes only
those keys, never a whole database, and has a second connection to look at TTLs and raw values.

```ts
describe.skipIf(!TestRedis.available)("SessionStore against Redis", (): void => {
    let redis: TestRedis;
    beforeAll(async (): Promise<void> => { redis = await TestRedis.connect(); });
    beforeEach((): void => redis.reset());          // default config, own prefix
    afterEach(async (): Promise<void> => await redis.clear());
    afterAll(async (): Promise<void> => await redis.close());
    // redis.configure({GATEWAY_REPLAY_BUFFER_SIZE: "3"}), redis.ttl(key), redis.json(key), redis.exists(key)
});
```

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
- Exceptions to the prefix: `core/logging/Logger.ts` (not `LoggingLogger`) and `core/config/EnvMapping.ts`.
- Up to ~400 lines per file – merge what belongs together, split by role when a file outgrows that.

| Suffix           | Role                                                                       | Examples                                                                          |
|------------------|----------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| `…Controller`    | HTTP endpoints (`@Route`) – read the request, delegate, build the response | `HealthController`, `EventSubWebhookController`                                   |
| `…Server`        | Owns a listening socket (`Bun.serve`)                                      | `HttpServer`, `GatewayServer`                                                     |
| `…Client`        | Wrapper around an external system, no business logic                       | `RedisClient`, `TwitchClient`                                                     |
| `…Store`         | The only owner of its Redis keys                                           | `SessionStore`, `AppStore`                                                        |
| `…Manager`       | Owns the lifecycle of a resource: create, reuse, sync, restore             | `ConfigManager`, `EventSubConduitManager`                                         |
| `…Service`       | Business logic / orchestration without an own resource                     | `AppSetupService`                                                                 |
| `…Handler`       | Handles the incoming messages of a protocol – one method per message type  | `GatewayHandler` (opcodes), `EventSubMessageHandler` (notifications, revocations) |
| `…Authenticator` | Verifies credentials, issues and renews tokens                             | `AppAuthenticator`                                                                |
| `…Registry`      | Keeps things of this instance in memory                                    | `ConnectionRegistry` (sockets), `MetricsRegistry` (counters)                      |
| `…Limiter`       | Counts attempts and blocks beyond a limit                                  | `AppAuthFailureLimiter`                                                           |
| `…Dispatcher`    | Fans something out to many receivers                                       | `SessionDispatcher`                                                               |
| `…Reporter`      | Describes something for another bean, does nothing itself                  | `ErrorReporter`                                                                   |

Files without `@Bean` – nothing is injected into them, they are imported directly (inside their feature or from `core`):

| Suffix         | Holds                                                        | Examples                                              |
|----------------|--------------------------------------------------------------|-------------------------------------------------------|
| `…Protocol`    | wire format: opcodes, close codes, payload types and schemas | `GatewayProtocol`                                     |
| `…Keys`        | key builders                                                 | `RedisKeys`                                           |
| `…Rules`       | data that decides something                                  | `EventSubScopeRules`                                  |
| `…Scripts`     | the Lua scripts of a store                                   | `SessionStoreScripts`                                 |
| `…Helper`      | pure functions on a shape                                    | `EventSubSubscriptionHelper`                          |
| `…Response`    | a shared HTTP response                                       | `HttpErrorResponse` (`format()`: the JSON error body) |
| `…Schema`      | the zod schema of a shape                                    | `ConfigSchema`                                        |
| `…Mapping`     | a table that maps one thing to another                       | `EnvMapping` (variable → option)                      |
| `…Decorators`  | the decorator functions                                      | `BeanDecorators`, `GatewayBeanDecorators`             |
| `…Transaction` | a builder for the commands of one call                       | `RedisClientTransaction`                              |

### Where does new code go?

| I want …                         | Here                                                                                                                                                                                               |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| a new HTTP endpoint              | a `@Route` in a `<Prefix>…Controller` of the feature folder                                                                                                                                        |
| a new client opcode              | an `@OpCode(op, schema)` method in `GatewayHandler` – `GatewayServer` routes and validates it                                                                                                      |
| a new health check               | a `@HealthCheck(name)` method on the bean it checks – it appears in `GET /health` under `checks.<name>`                                                                                            |
| a new metric                     | a counter: `metricsRegistry.increment(name, help, labels)` where it happens – label values only from a fixed set, never client input; a gauge: in `HealthMetricsController` (read on every scrape) |
| work that needs Redis on startup | an `@OnRedisReady()` method – not `@PostConstruct`, Redis may not be up yet                                                                                                                        |
| a new Redis key                  | a builder in `core/redis/RedisKeys.ts`, the `…Store` that owns it and the [key tree](#redis)                                                                                                       |
| a new Twitch API call            | a method in `twitch/TwitchClient.ts`                                                                                                                                                               |
| a new EventSub type / scope      | see [EventSub](#eventsub)                                                                                                                                                                          |
| a recurring job                  | a `@Cron(...)` method on the bean that owns the job                                                                                                                                                |
| a new config option              | see [Contributing Guide](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CONTRIBUTING.md#adding-a-configuration-option)                                                            |
| a new feature                    | a new singular folder in `src/` (`src/clip/`) with files like `ClipStore.ts`, `ClipController.ts`                                                                                                  |

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

| Decorator                                                  | Effect                                                                                                                                                                                                                                                                                                    |
|------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `@Bean()`                                                  | creates the class once and registers it under its class name                                                                                                                                                                                                                                              |
| `@MainClass()`                                             | only on `Main`: installs the process handlers, runs every `@PostConstruct`, then the crons; a failing `@PostConstruct` stops the startup through `ProcessManager.shutdown()`                                                                                                                              |
| `@Autowired()`                                             | injects another bean – property name = class name in camelCase, import it with `import type`                                                                                                                                                                                                              |
| `@PostConstruct()`                                         | runs after all modules are loaded, in import order; must never block forever                                                                                                                                                                                                                              |
| `@Route(method, path)`                                     | HTTP route served by `HttpServer`                                                                                                                                                                                                                                                                         |
| `@Cron(cronTime)`                                          | recurring job, seconds allowed (`*/5 * * * * *`) – the only way to schedule recurring work                                                                                                                                                                                                                |
| `@HealthCheck(name)`                                       | part of `GET /health` and the health push: returns `{ok, failure?, details?}` – one that isn't `ok` makes the gateway degraded, `details` appear under `checks.<name>`                                                                                                                                    |
| `@OnRedisReady()`                                          | runs once, as soon as Redis is reachable for the first time – not again after a reconnect                                                                                                                                                                                                                 |
| `@OpCode(op, schema)` (`gateway/GatewayBeanDecorators.ts`) | handles a client opcode: `GatewayServer` validates `d` with the schema (else 4002) and calls the method with it; unknown opcodes are closed with 4001. Registered in the `BeanManager` handler table `opcode` – the decorator lives in `gateway`, `core` knows no opcodes                                 |
| `@ShutdownHook(order)`                                     | runs on SIGINT/SIGTERM, lowest order first (`ProcessManager` catches the signal, `BeanManager.runShutdownHooks()` stops the crons and runs the hooks, then `ProcessManager` exits). `ProcessManager` is a bean without `@PostConstruct`; `@MainClass` calls its `install()` before every `@PostConstruct` |

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

## Formatting

ESLint checks quotes, spacing and trailing commas – also after the last argument of a call or the last parameter
when they are wrapped (`bun run lint:fix` adds them); the layout below is not checked, so keep to it by hand. A line
has at most 120 characters.

```ts
// Object literals: one property per line with a trailing comma – also log fields, return values and options,
// even with a single property. Only shorthand objects may stay on one line ({port}, {accessToken, clientId}).
this.logger.info("SESSION", "Resumed", {
    id: sessionId,
    app: clientId,
    replayed: replay.length,
});
return {
    status: "claimed",
    pending,
};

// Too long for one line: arrays one entry per line, chains with the dot in front, the body of an arrow function on
// the next line, conditions with && / || in front and the closing parenthesis on its own line.
await client.send("SET", [
    key,
    JSON.stringify(value),
    "NX",
]);
const entries: [string, string][] = Object.entries(labels)
    .sort(([a]: [string, string], [b]: [string, string]): number => a.localeCompare(b));
const existing: EventSubSubscription[] = subs.filter((sub: EventSubSubscription): boolean =>
    EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId),
);
if (!EventSubSubscriptionHelper.isOnConduit(sub, app.conduitId)
    || publicKeys.has(EventSubSubscriptionHelper.subscriptionKey(sub))
) continue;
```

- Imports: Node built-ins, then packages, then `@core`/`@twitch`/`@gateway`/`@health` sorted by path; named imports
  one per line when the line gets too long. Inside `src/` always the alias with `.ts`; only the side effect imports in
  `Main.ts` leave the extension out.
- A value that is used once goes straight where it's used instead of into a variable of its own, unless the name
  explains something.
- A shape used more than once gets a named `interface` – no repeated inline object types. Members of an interface one
  per line.

## Logging and Errors

```
2026-11-16 19:20:01 [SUCCESS] [SESSION]    | Identified  id=2b6c3e64-… app=gp762n… conn=9a1f0c2e-…
2026-11-16 19:20:02 [WARN]    [EVENTSUB]   | Subscribe failed  app=gp762n… type=channel.chat.message broadcaster_user_id=111 user_id=999
{
  "error": {"code": "HTTP_ERROR", "message": "POST api.twitch.tv/helix/eventsub/subscriptions failed with status 403",
            "details": {"request": {"method", "url", "headers", "body"}, "response": {"status", "headers", "body"}}},
  "context": {"app": "gp762n…", "type": "channel.chat.message", "condition": {…}},
  "location": {"file": "EventSubSubscriptionManager.ts", "line": 69, "method": "createSubscriptions"}
}
```

With `LOG_FORMAT=json` the same line is one JSON object (`time`, `level`, `module`, `message`, `fields`, `error`, …) –
the rules below apply to both formats.

Every log line belongs to the most specific module of `LogModule` (`src/core/logging/Logger.ts`):

| Module       | For                                         |
|--------------|---------------------------------------------|
| `SYSTEM`     | startup, shutdown, process                  |
| `CONDUIT`    | conduits and shards                         |
| `REDIS`      | Redis connection                            |
| `EVENTSUB`   | subscriptions, limits, authorization events |
| `HTTP`       | HTTP server and routes                      |
| `WEBHOOK`    | incoming Twitch messages                    |
| `HEALTH`     | health push                                 |
| `GATEWAY`    | WebSocket server                            |
| `AUTH`       | client credentials, app tokens, auth blocks |
| `CONNECTION` | sockets, heartbeats, timeouts               |
| `APP`        | app setup, bot user, inactivity cleanup     |
| `SESSION`    | IDENTIFY, RESUME, close                     |
| `DISPATCH`   | sending events to sessions                  |

- **Message** short, without ids or values: `"Subscribe failed"`, not `"Failed to subscribe to x for app y"`.
  **Ids and values go into the fields** – never JSON in the line: an object (e.g. a condition) is spread into its own
  `key=value` pairs. A close code belongs into the message: `"Heartbeat missed, closing (4008)"`.
- **Field names:** the id of what the module is about comes first and is called `id` – the client id under `APP`,
  the conduit under `CONDUIT`, the subscription under `EVENTSUB`, the session under `SESSION`, the connection under
  `CONNECTION`; under `WEBHOOK` it is `message` (the Twitch message id). Then `app` (client id), then the rest with
  the usual keys: `user`, `botUser`, `session`, `conn`, `conduit`, `type`, `ip`, `count`, `reason`.
- **Levels:** `debug` per request, event or subscription (only with `LOG_DEBUG`), `info` for state changes,
  `success` when an action completed (connected, created, subscribed, identified), `warn` for what the gateway handles
  itself, `error` when something stays broken. Many similar actions → one `info` line with a
  `count`, the single ones as `debug`.
- **Errors** go along as the last argument: `this.logger.error("CONDUIT", "Could not create a conduit", {app}, error)`
  prints a JSON block below the line: code, message, details (a failed request with its headers and body and the
  response), the fields as `context` and the `location`; bugs (TypeError & co.) and `LOG_DEBUG` add the `stack`.
  `ErrorReporter` builds it and redacts every secret (headers, bodies, query parameters, fields).
  Something that can repeat per request or event uses `warnThrottled` (at most once per 30 s with a `suppressed` count).
  Own errors are thrown as `MainError("MACHINE_CODE", "message")`.
- **Latency:** on the hot path (webhook → socket), forward first – bookkeeping (Helix calls, logging) runs after the
  dispatch.
- **Never log or store client secrets or tokens in plain text.**

## Redis

Redis is the only datastore. One instance per Redis database. All state that must survive a restart lives in Redis;
what only concerns an open socket lives in memory in `ConnectionRegistry` – heartbeat timeouts, the rate limit and
the delivery queue – so no client message costs a Redis read just for bookkeeping.

```
twitch:apps:index                                       SET     all client ids                   AppStore
twitch:apps:<clientId>:app                              JSON    App (conduit, bot, types, flags) AppStore
twitch:apps:<clientId>:token                            JSON    app access token (TTL)           AppStore
twitch:apps:<clientId>:users                            SET     authorized user ids              AppStore
twitch:apps:<clientId>:public                           HASH    requested public subscriptions   AppStore
twitch:eventsub:messages:<messageId>                    STRING  webhook de-duplication (TTL)     EventSubWebhookStore

gateway:apps:<clientId>:sessions:index                  SET     session ids of the app           SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:session    JSON    session                          SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:seq        STRING  sequence number                  SessionStore
gateway:apps:<clientId>:sessions:<sessionId>:buffer     LIST    replay buffer                    SessionStore
gateway:apps:<clientId>:connections:<connectionId>      JSON    identified connection            ConnectionStore
gateway:pending:<connectionId>                          JSON    before IDENTIFY/RESUME           ConnectionStore
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

1. Add a row to `scopeRules` in `twitch/eventsub/EventSubScopeRules.ts` for the scope(s) Twitch requires (see the
   [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)) and a case to
   `test/unit/twitch/eventsub/EventSubScopeService.test.ts`.
2. Take the highest version Twitch offers – `beta` if the type exists only as beta. A version bump of a type that is
   already subscribed is a breaking change for clients (the event changes), so document it.
3. Special handling goes into `EventSubMessageHandler`. Nothing to do for a new Twitch event otherwise – every EventSub type
   is forwarded automatically (`channel.chat.message` → `CHANNEL_CHAT_MESSAGE`).

Subscriptions are compared by **type + version + condition**, never by type alone.
