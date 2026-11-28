<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/.assets/eventsub-gateway-readme-banner.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/.assets/eventsub-gateway-readme-banner-dark.svg">
    <img src="https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/.assets/eventsub-gateway-readme-banner-dark.svg" alt="eventsub-gateway" width="600"/>
  </picture>
</p>

<p align="center">
  <strong>
    All of Twitch EventSub through one WebSocket connection. Your app connects with its client id and secret – the
    self-hosted gateway handles everything around it: the conduit, creating subscriptions for every authorized user,
    watching revocations and replaying missed events after a reconnect.
  </strong>
</p>

<p align="center">
  <a href="https://github.com/twive-app/eventsub-gateway/releases/latest"><img src="https://img.shields.io/github/v/release/twive-app/eventsub-gateway?sort=semver&display_name=tag&label=release" alt="latest release" /></a>
  <a href="https://github.com/twive-app/eventsub-gateway/pkgs/container/eventsub-gateway"><img src="https://img.shields.io/badge/image-ghcr.io%2Ftwive--app%2Feventsub--gateway-2496ed?logo=docker&logoColor=fff" alt="docker image" /></a>
  <a href="https://github.com/twive-app/eventsub-gateway/actions/workflows/build.yaml"><img src="https://img.shields.io/github/actions/workflow/status/twive-app/eventsub-gateway/build.yaml?branch=main&label=build" alt="build" /></a>
  <a href="https://github.com/twive-app/eventsub-gateway/blob/main/LICENSE"><img src="https://img.shields.io/github/license/twive-app/eventsub-gateway" alt="license" /></a>
  <a href="https://github.com/twive-app/eventsub-gateway/commits/main"><img src="https://img.shields.io/github/last-commit/twive-app/eventsub-gateway.svg?logo=github&logoColor=ffffff" alt="last commit" /></a>
  <a href="https://github.com/twive-app/eventsub-gateway/graphs/contributors"><img src="https://img.shields.io/github/contributors/twive-app/eventsub-gateway.svg?maxAge=3600&logo=github&logoColor=fff&color=00c7be" alt="contributors" /></a>
</p>

> [!WARNING]
> **Work in progress.** The gateway is covered by unit, flow and integration tests, but it has not yet been tested in
> production at scale – many apps, many users, high event volume. The protocol and the configuration may still change
> before a stable `v1.0.0`. Please [open an issue](https://github.com/twive-app/eventsub-gateway/issues/new/choose) when something doesn't work.

## Features

```
Twitch EventSub ──Webhook──▶ EventSub Gateway powered by twive.app ──WebSocket──▶ your app
   (conduit)                             (Redis)                   (e.g. wss://gateway.example.com)
```

Your app connects with its Twitch client id + secret and receives every EventSub event of every user who authorized
it – no webhook endpoint, no conduit and no subscription calls of its own. Each point links to the details.

**Events and sessions**

- **One connection, every event:** every notification reaches all sessions of your application as `DISPATCH`, the
  `event` object unchanged ([events](docs/GATEWAY.md#dispatch-events)). Several clients of the same app share one
  conduit.
- **Event filter:** a session can receive only the events it lists in IDENTIFY ([IDENTIFY](docs/GATEWAY.md#identify-op-1)).
- **Nothing gets lost:** events carry gap-free sequence numbers; a dropped connection `RESUME`s within 2 minutes and
  gets every missed event replayed (last 500), even across gateway restarts ([RESUME](docs/GATEWAY.md#resume-op-2)).
- **Everything for your own Helix calls:** READY hands over a valid app access token, the conduit id and the users who
  authorized the app ([READY](docs/GATEWAY.md#ready-dispatch)); the token is renewed before it expires
  ([RECONNECT](docs/GATEWAY.md#reconnect-op-6)).

**Subscriptions**

- **Automatic per user:** when a user authorizes the app, the gateway subscribes to every event the granted scopes
  allow – or only the types your app picked with `subscriptionTypes` – and tells your app with `USER_SUBSCRIBED` once
  they arrive; when the user revokes it, the gateway forgets the user
  ([USER_SUBSCRIBED](docs/GATEWAY.md#user_subscribed), [IDENTIFY](docs/GATEWAY.md#identify-op-1)).
- **Chat as your bot:** with a `botUserId` the chat subscriptions use your bot account – and move to a new bot when it
  changes ([IDENTIFY](docs/GATEWAY.md#identify-op-1)).
- **Other channels:** subscribe to events that need no authorization (e.g. `stream.online`) for any channel, and list
  every subscription with its cost ([HTTP endpoints](docs/GATEWAY.md#subscribing-to-other-channels-http)).
- **Failures are reported, not hidden:** `SUBSCRIPTION_FAILED` and `SUBSCRIPTION_REVOKED` tell your app what Twitch
  refused or revoked and why ([events](docs/GATEWAY.md#subscription_revoked)); the gateway warns when an app nears
  Twitch's subscription limit.

**Self-repair**

- **Conduit check:** every 5 minutes while clients are connected, a disabled shard is enabled again, a deleted
  conduit is replaced with all its subscriptions, and revoked authorization subscriptions are created again
  ([How it works](docs/GATEWAY.md#how-it-works)).
- **Revocations by reason:** subscriptions Twitch revoked although the user still authorizes the app (e.g. after a
  password change) are created again; a deleted account is forgotten.
- **Redis loss:** if Redis loses its data, the next IDENTIFY takes the users and subscriptions over from the old
  conduit ([Redis](docs/CONFIGURATION.md#redis)).
- **Restarts:** clients get RECONNECT and RESUME afterward; webhooks still being processed are finished first.

**Security**

- **Webhooks:** signature check, replay protection (10 minutes) and de-duplication of Twitch's retries.
- **Credentials:** the client secret is never stored (only a keyed hash), secrets and tokens never appear in logs;
  repeated wrong credentials block the address for a while.
- **Limits:** message rate limit per connection, connection limits per address (IPv6 per prefix), slow clients are
  disconnected before they miss more than they can RESUME ([connection limits](docs/SETUP.md#connection-limits),
  [client addresses](docs/SETUP.md#client-addresses-trusted_proxies)).
- **Supply chain:** images and release binaries carry a signed build provenance (`gh attestation verify`), images an
  SBOM; a dependency audit and an image scan run in CI.

**Operations**

- **Easy to run:** one Docker image (`linux/amd64`, `linux/arm64`), standalone Linux executables or a Pelican egg
  ([setup guide](docs/SETUP.md)).
- **Monitoring:** `GET /health`, a Docker `HEALTHCHECK`, push monitoring for Uptime Kuma & co., Prometheus metrics and
  JSON logs ([monitoring](docs/SETUP.md#10-monitoring)).
- **Cleans up after itself:** the conduit of an app without clients is deleted after 30 days, the whole app after 180
  ([inactive apps](docs/SETUP.md#inactive-apps)); Twitch's API rate limit is respected.

## Versions

The latest release is shown by the badge above; every release lists its changes in the
[release notes](https://github.com/twive-app/eventsub-gateway/releases).

| Channel     | Docker image                                                     | For                                                      |
|-------------|------------------------------------------------------------------|----------------------------------------------------------|
| Stable      | `ghcr.io/twive-app/eventsub-gateway:latest` or a fixed `:vX.Y.Z` | production – pin `vX.Y.Z` to update on your own schedule |
| Prerelease  | `:beta`, `:rc`, `:alpha`                                         | trying the next version                                  |
| Development | `:dev` (latest commit on `dev`)                                  | testing – may break at any time                          |

All tags are explained in the [setup guide](docs/SETUP.md#image-tags); the version of a running gateway is in its start
log, in `GET /health` and in `gateway --version`.

## Documentation

|                                         |                                                                                                                                           |
|-----------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| [Setup guide](docs/SETUP.md)            | Run your own gateway – Docker, reverse proxy, updating, monitoring, troubleshooting                                                       |
| [Configuration](docs/CONFIGURATION.md)  | Every environment variable and the Redis requirements                                                                                     |
| [Gateway](docs/GATEWAY.md)              | Connect a client: payloads, opcodes, events, RESUME, close codes – plus a complete [example client](examples/eventsub-gateway-client.mjs) |
| [Contributing](.github/CONTRIBUTING.md) | Development setup, scripts, commit rules, pull requests                                                                                   |
| [Codebase](.github/CODEBASE.md)         | Project structure and code conventions                                                                                                    |
| [Releasing](.github/RELEASING.md)       | Release process, image tags and automatic builds (maintainers)                                                                            |
| [Security](.github/SECURITY.md)         | Report vulnerabilities privately, not as an issue                                                                                         |

## Quick start

You need a server with Docker, a domain with a reverse proxy (TLS) in front of the gateway and a webhook secret
(`openssl rand -hex 32`):

```bash
curl -fsSLO https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/compose.yml
curl -fsSL https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/.env.example -o .env
# .env: TWITCH_WEBHOOK_CALLBACK_URL=https://api.example.com/twitch/webhook/callback, TWITCH_WEBHOOK_SECRET=…
docker compose up -d
```

This starts the gateway (`ghcr.io/twive-app/eventsub-gateway:latest`) and a Redis with persistence. The ports `3000`
(webhook, HTTP endpoints, `/health`) and `3001` (WebSocket) listen on `127.0.0.1` for your reverse proxy – the
[setup guide](docs/SETUP.md) walks through the proxy, checking the setup and connecting the first app. Standalone
executables for Linux are attached to every [release](https://github.com/twive-app/eventsub-gateway/releases), and for
the [Pelican Panel](https://pelican.dev) there is an [egg](pelican/egg-eventsub-gateway.yaml)
([setup](docs/SETUP.md#12-pelican-panel)). To try it or develop an app on your own computer, a tunnel replaces the
server and the domain – see [On your own computer](docs/SETUP.md#on-your-own-computer).

## Contributing

Contributions are welcome! Branch from `dev`, follow the commit rules and open a pull request against `dev` – the
[Contributing Guide](.github/CONTRIBUTING.md) has the details.

## License

[MIT](LICENSE) – eventsub-gateway is a part of [twive.app](https://twive.app) and not affiliated with Twitch.
