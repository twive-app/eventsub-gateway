# Contributing Guide

Welcome to **EventSub Gateway**, a part of *[twive.app](https://twive.app)*! We appreciate your interest in
contributing to this project. To ensure a smooth collaboration, please follow the guidelines outlined below:

- [Code of Conduct](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CODE_OF_CONDUCT.md)
- [Get Started](#get-started)
- [Development Environment Setup](#development-environment-setup)
- [How to Contribute](#how-to-contribute)
- [Adding a configuration option](#adding-a-configuration-option)
- [Codebase Structure](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CODEBASE.md)
- [Security Policy](https://github.com/twive-app/eventsub-gateway/blob/main/.github/SECURITY.md)
- [Releasing](https://github.com/twive-app/eventsub-gateway/blob/main/.github/RELEASING.md) (for maintainers)

## Get Started
To contribute, you should have a basic familiarity with:

- [TypeScript](https://www.typescriptlang.org) as the language
- [Bun](https://bun.com) as runtime, package manager and bundler (there is no Node.js/npm toolchain)
- [Redis](https://redis.io) as the only datastore
- [Docker](https://www.docker.com) for the image and the local `compose.yml`
- [Git](https://git-scm.com) & [GitHub](https://github.com) as version control and collaboration platform
- [Twitch EventSub](https://dev.twitch.tv/docs/eventsub/), especially
  [webhooks](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/) and
  [conduits](https://dev.twitch.tv/docs/eventsub/handling-conduit-events/)
- [ESLint](https://eslint.org) for code-style

## Development Environment Setup
You will need [Bun](https://bun.com) (the exact version is pinned in `engines.bun` of
[`package.json`](https://github.com/twive-app/eventsub-gateway/blob/main/package.json)), Docker (or a local Redis ≥ 7.2)
and a Twitch application from the [Twitch Developer Console](https://dev.twitch.tv/console/apps).

1. Fork the repository on GitHub
2. Clone your forked repository to your local machine
3. Navigate to the project directory
4. Install the dependencies with:
   ```bash
   bun install
   ```
5. Create your configuration and fill in the `REQUIRED` block (see
   [Configuration](https://github.com/twive-app/eventsub-gateway/blob/main/docs/CONFIGURATION.md)):
   ```bash
   cp .env.example .env
   ```
   `TWITCH_WEBHOOK_SECRET` can be generated with `openssl rand -hex 32`. Clients connect to
   `ws://localhost:3001` (`GATEWAY_PORT`).
6. Start a Redis that is reachable on `localhost:6379` (the one in `compose.yml` publishes no port), e.g.:
   ```bash
   docker run -d --name twive-redis-dev -p 127.0.0.1:6379:6379 redis:8.10.3-alpine
   ```
   Use the same image tag as `compose.yml` and update both together.
7. Start the gateway in watch mode:
   ```bash
   bun run dev
   ```

**Webhooks locally:** Twitch only delivers EventSub webhooks to a public HTTPS URL on port 443. Expose the HTTP port
(`SERVER_PORT`, default `3000`) with a tunnel such as [ngrok](https://ngrok.com) (`ngrok http 3000`) or
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`cloudflared tunnel --url http://localhost:3000`) and set
`TWITCH_WEBHOOK_CALLBACK_URL=https://<your-tunnel>/twitch/webhook/callback`.

**Testing:** [`examples/gateway-client.mjs`](https://github.com/twive-app/eventsub-gateway/blob/main/examples/gateway-client.mjs)
is a complete client with heartbeats and automatic RESUME:

```bash
TWITCH_CLIENT_ID=… TWITCH_CLIENT_SECRET=… TWITCH_BOT_USER_ID=123456789 bun examples/gateway-client.mjs
```

**Scripts:**

| Script | Description |
|---|---|
| `bun run dev` | Start with file watching (`bun --watch src/index.ts`) |
| `bun run start` | Start from source (`bun src/index.ts`) |
| `bun run build` | Bundle to `out/index.js` (`bun build --target bun`), run it with `bun out/index.js` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint:check` | ESLint (`lint:fix` to fix formatting) |
| `bun run lint:commits` | commitlint for every commit since `origin/dev` |
| `docker compose up --build` | Redis + gateway in Docker, built from this repository |

## How to Contribute
- For larger changes (new features, refactorings across several files) please
  [open an issue](https://github.com/twive-app/eventsub-gateway/issues/new/choose) first so we can agree on the
  approach.
- Create a new branch from `dev` for your changes – `main` is the release branch.
- Keep one topic per pull request.
- Follow the existing code style and conventions (see
  [Codebase Structure](https://github.com/twive-app/eventsub-gateway/blob/main/.github/CODEBASE.md)).
- Write commit messages that follow the [conventional commits](https://www.conventionalcommits.org) format:
  - `type(Scope): subject`, header at most 120 characters, scope in PascalCase – e.g. `feat(Gateway): add …`,
    `fix(EventSub): …`
  - types: `feat`, `fix`, `refactor`, `perf`, `style`, `test`, `docs`, `build`, `chore`, `src`, `ci`, `revert`
  - Pull requests are merged with a merge commit, so the CI checks **every commit** of a pull request with commitlint
    (`@commitlint/config-angular`), not only its title. Check yours locally with `bun run lint:commits` (all commits
    since `origin/dev`). To fix a message, use `git commit --amend` for the last commit and `git rebase -i` for older
    ones, then force-push your branch.
- Before opening a pull request, make sure these commands pass with 0 errors:
  ```bash
  bun run typecheck
  bun run lint:check     # bun run lint:fix fixes formatting
  bun run lint:commits   # commit messages since origin/dev
  ```
- Open a pull request against the `dev` branch of the original repository for your changes to be reviewed and merged.
- Mark your pull request as a Draft if you are still working on it.
- Never commit secrets – no client secrets, tokens or webhook secrets in code, logs or screenshots.

## Adding a configuration option
The gateway is configured only through environment variables. A new option needs all of:

1. a field in `configSchema` in `src/core/config/ConfigManager.ts` with a sensible `.default()` (or `required: true`
   in its mapping if there is no sensible default)
2. an entry in `envMappings` in the same file (`SECTION_KEY` in upper snake case, `file: true` for secrets)
3. the variable with a short comment and its default in
   [`.env.example`](https://github.com/twive-app/eventsub-gateway/blob/main/.env.example)
4. a row in the [configuration table](https://github.com/twive-app/eventsub-gateway/blob/main/docs/CONFIGURATION.md) in
   `docs/CONFIGURATION.md`

## Releasing
Releases are cut by maintainers from `main` – the whole process is in
[RELEASING.md](https://github.com/twive-app/eventsub-gateway/blob/main/.github/RELEASING.md) (for maintainers).
