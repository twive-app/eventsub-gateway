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

## Features

```
Twitch EventSub ──Webhook──▶ EventSub Gateway ──WebSocket──▶ your app
   (conduit)                      (Redis)             (e.g. wss://gateway.example.com)
```

- **One connection, every event:** no webhook endpoint, no conduit and no subscription calls in your app. It connects
  with its Twitch client id + secret – the gateway sets up the conduit, subscribes whenever a user authorizes the app
  (to every event the granted scopes allow), cleans up on revocations and keeps the bot's chat subscriptions in sync.
- **Nothing gets lost:** events arrive as `DISPATCH` with sequence numbers; dropped connections `RESUME` and get missed
  events replayed, even across gateway restarts.
- **Secure by default:** webhook signatures, replay protection, message de-duplication, rate and connection limits.
- **Easy to run:** one Docker image (`linux/amd64`, `linux/arm64`), standalone Linux executables or a Pelican egg –
  with a health endpoint and push monitoring for Uptime Kuma & co.

## Versions

The latest release is shown by the badge above; every release lists its changes in the
[release notes](https://github.com/twive-app/eventsub-gateway/releases).

| Channel | Docker image | For |
|---|---|---|
| Stable | `ghcr.io/twive-app/eventsub-gateway:latest` or a fixed `:vX.Y.Z` | production – pin `vX.Y.Z` to update on your own schedule |
| Prerelease | `:beta`, `:rc`, `:alpha` | trying the next version |
| Development | `:dev` (latest commit on `dev`) | testing – may break at any time |

All tags are explained in the [setup guide](docs/SETUP.md#image-tags); the version of a running gateway is in its start
log, in `GET /health` and in `gateway --version`.

## Documentation

| | |
|---|---|
| [Setup guide](docs/SETUP.md) | Run your own gateway – Docker, reverse proxy, updating, monitoring, troubleshooting |
| [Configuration](docs/CONFIGURATION.md) | Every environment variable and the Redis requirements |
| [Gateway](docs/GATEWAY.md) | Connect a client: payloads, opcodes, events, RESUME, close codes – plus a complete [example client](examples/gateway-client.mjs) |
| [Contributing](.github/CONTRIBUTING.md) | Development setup, scripts, commit rules, pull requests |
| [Codebase](.github/CODEBASE.md) | Project structure and code conventions |
| [Releasing](.github/RELEASING.md) | Release process, image tags and automatic builds (maintainers) |
| [Security](.github/SECURITY.md) | Report vulnerabilities privately, not as an issue |

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
(webhook, `/health`) and `3001` (WebSocket) listen on `127.0.0.1` for your reverse proxy – the
[setup guide](docs/SETUP.md) walks through the proxy, checking the setup and connecting the first app. Standalone
executables for Linux are attached to every [release](https://github.com/twive-app/eventsub-gateway/releases), and for
the [Pelican Panel](https://pelican.dev) there is an [egg](pelican/egg-eventsub-gateway.yaml)
([setup](docs/SETUP.md#12-pelican-panel)).

## Contributing

Contributions are welcome! Branch from `dev`, follow the commit rules and open a pull request against `dev` – the
[Contributing Guide](.github/CONTRIBUTING.md) has the details.
