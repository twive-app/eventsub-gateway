# Setup guide

Run your own EventSub Gateway – from an empty server to the first event in a client. For the protocol your apps
speak, see [`GATEWAY.md`](GATEWAY.md); every variable is listed in [`CONFIGURATION.md`](CONFIGURATION.md).

- [1. Overview](#1-overview)
- [2. Requirements](#2-requirements)
- [3. Webhook secret](#3-webhook-secret)
- [4. Start with Docker Compose](#4-start-with-docker-compose)
- [5. Reverse proxy and TLS](#5-reverse-proxy-and-tls)
- [6. Check that everything works](#6-check-that-everything-works)
- [7. Connect an app](#7-connect-an-app)
- [8. Without Docker](#8-without-docker)
- [9. Updating](#9-updating)
- [10. Monitoring](#10-monitoring)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Pelican Panel](#12-pelican-panel)

## 1. Overview

Twitch delivers EventSub events of every connected app to the gateway's webhook (through one conduit per app). The
gateway verifies them and forwards them over a WebSocket to the app's clients – the apps need no public endpoint of
their own.

The gateway listens on two ports:

| Port | Default | Serves | Public? |
|---|---|---|---|
| `SERVER_PORT` | `3000` | `POST /twitch/webhook/callback` (Twitch), `GET /health` (monitoring) | the webhook: **yes, via HTTPS on port 443** – Twitch calls nothing else |
| `GATEWAY_PORT` | `3001` | the WebSocket gateway for your apps' clients | **yes**, as `wss://` through your reverse proxy |

Neither port should be reachable directly from the internet – put both behind a reverse proxy that terminates TLS.
Redis is never public.

## 2. Requirements

- A server with **Docker** and Docker Compose v2 – or Linux (x64 or arm64, glibc) for the [standalone executable](#8-without-docker).
- A **domain** (or two subdomains) pointing to the server, and a reverse proxy with TLS – e.g. Caddy, Nginx or Nginx
  Proxy Manager.
- **Redis ≥ 7.2 with persistence (AOF)** – the only datastore. `compose.yml` brings one along. Without persistence a
  Redis restart forgets every app, and every app gets a new conduit on its next IDENTIFY.
- **No Twitch application of your own.** Every app that connects brings its own client id and secret; the gateway
  creates the conduit and the subscriptions with them.

## 3. Webhook secret

Twitch signs every webhook with a secret (HMAC-SHA256), the gateway rejects every message whose signature doesn't
match. Generate one (10–100 characters):

```bash
openssl rand -hex 32
```

and set it as `TWITCH_WEBHOOK_SECRET` (or put it into a file and set `TWITCH_WEBHOOK_SECRET_FILE`).

**Changing it later:** Twitch keeps signing with the secret stored in each app's conduit shard. The gateway writes the
shard (callback URL + secret) on the **first IDENTIFY of each app after the gateway started** – a RESUME does not.
Until an app identifies again after the restart, its events are signed with the old secret and rejected (`403`).
So change the secret only together with a restart after which your apps' clients IDENTIFY (not just RESUME).

## 4. Start with Docker Compose

```bash
mkdir eventsub-gateway && cd eventsub-gateway
curl -fsSLO https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/compose.yml
curl -fsSL https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/.env.example -o .env
```

Fill in the `REQUIRED` block of `.env`:

```dotenv
TWITCH_WEBHOOK_CALLBACK_URL=https://api.example.com/twitch/webhook/callback
TWITCH_WEBHOOK_SECRET=<output of openssl rand -hex 32>
```

`TWITCH_WEBHOOK_CALLBACK_URL` is the public HTTPS URL of `POST /twitch/webhook/callback` – see
[section 5](#5-reverse-proxy-and-tls). Everything else has defaults (see `.env.example`). Then:

```bash
docker compose up -d
docker compose logs -f gateway     # "Gateway is now running!"
docker compose ps                  # gateway: healthy
```

`compose.yml` publishes `3000` and `3001` only on `127.0.0.1` – for a reverse proxy on the same host. Docker bypasses
host firewalls like ufw, so ports published on all interfaces would be reachable from the internet. Remove the
`127.0.0.1:` in the `ports` of the gateway service only if there is no proxy or it runs on another host.

The bundled Redis has no password and is only reachable inside the compose network – leave `REDIS_USERNAME` and
`REDIS_PASSWORD` in `.env` empty. To use your own Redis instead, set `REDIS_HOST` (and if needed `REDIS_PORT`,
`REDIS_DB`, `REDIS_USERNAME`, `REDIS_PASSWORD`) in `.env` – `compose.yml` picks it up automatically, and the start log
shows which Redis is used (`Connected to Redis at …`). The bundled Redis then keeps running unused; delete the `redis`
service and the `depends_on` of the gateway in `compose.yml` if you don't want it.

**"WARNING Memory overcommit must be enabled!"** in the Redis log: Redis saves in the background by forking; with
overcommit disabled, that fork can fail when memory is tight, and the background save (and with it persistence) fails.
Enable it **on the host** – a container can't change this kernel setting, so it can't go into `compose.yml`:

```bash
sudo sysctl vm.overcommit_memory=1                                      # now
echo "vm.overcommit_memory = 1" | sudo tee /etc/sysctl.d/99-redis.conf  # after every reboot
```

## 5. Reverse proxy and TLS

Two layouts work:

- **Two subdomains:** `api.example.com` → `SERVER_PORT` (webhook, `/health`) and `gateway.example.com` →
  `GATEWAY_PORT`. Clients connect to `wss://gateway.example.com/?v=1&encoding=json`.
- **One domain:** `/twitch/*` and `/health` → `SERVER_PORT`, everything else → `GATEWAY_PORT`. The WebSocket server
  accepts the upgrade on any path, so clients connect to `wss://example.com/?v=1&encoding=json`.

The proxy must pass the WebSocket upgrade and keep idle WebSocket connections open longer than the heartbeat interval
(`GATEWAY_HEARTBEAT_INTERVAL`, 41.25 s by default) – 120 s is a safe read timeout.

**Caddy** (TLS and WebSocket upgrades are automatic, no idle timeout by default):

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:3000
}

gateway.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

One domain instead:

```caddyfile
example.com {
    handle /twitch/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle /health {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        reverse_proxy 127.0.0.1:3001
    }
}
```

**Nginx** (certificates e.g. from certbot):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name api.example.com;
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 443 ssl;
    server_name gateway.example.com;
    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

**Nginx Proxy Manager:** one proxy host per subdomain; enable **"Websockets Support"** on the gateway host.

### Client addresses (`TRUSTED_PROXIES`)

The gateway uses the client's address for its logs and its per-address limits. Behind a proxy, every request comes
from the proxy – the real address is in `X-Forwarded-For`, which any client can also send itself. The gateway
therefore only reads it when the request comes from an address in `TRUSTED_PROXIES` (IPs and CIDRs, IPv4 and IPv6,
comma separated). It reads the header from the right and takes the first address that isn't a trusted proxy itself.
Without `TRUSTED_PROXIES`, `X-Forwarded-For` is ignored and every client of the proxy shares the proxy's address – and
with it the limits below.

Which address to trust depends on how the proxy reaches the gateway:

| Setup | The gateway sees | `TRUSTED_PROXIES` |
|---|---|---|
| Proxy on the host, gateway without Docker | `127.0.0.1` / `::1` | `127.0.0.1,::1` |
| Proxy on the host, gateway from `compose.yml` | the gateway of the Docker bridge, e.g. `172.18.0.1` – **not** `127.0.0.1` | `172.16.0.0/12` (or the exact network) |
| Proxy as a container in the same compose network | the proxy container's address | the network's subnet |

To find the address, start with `LOG_DEBUG=true` and open `https://api.example.com/health` – the log shows
`GET /health from <address>`. Once `TRUSTED_PROXIES` is right, it shows `from <your address> via <proxy>`. Or look
up the subnet of the compose network:

```bash
docker network inspect eventsub-gateway_default --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
# 172.18.0.0/16   (the network is called <project>_default, `docker network ls` lists them)
```

Only trust addresses that nobody but your proxy can connect from. The examples above set `X-Forwarded-For` correctly:
nginx appends the client's address (`$proxy_add_x_forwarded_for`), Caddy sets it by default.

### Connection limits

The gateway protects itself – and Twitch, which throttles the server's IP for **every** app when it gets too many
token requests – with limits per client address (all in memory, reset on restart):

- **`GATEWAY_MAX_CONNECTIONS_PER_IP`** (default `100`) simultaneous connections; further ones are closed with `4007`.
  Raise it if many clients run behind one address – e.g. a bot with many shards on one server, or several apps
  behind a NAT. `GATEWAY_MAX_CONNECTIONS` (default unlimited) caps all connections together.
- **`GATEWAY_AUTH_FAILURE_LIMIT`** (default `10`) failed IDENTIFY/RESUME (wrong client secret, unknown `botUserId`)
  within `GATEWAY_AUTH_FAILURE_WINDOW_MS` (default 10 minutes). After that, every connection from the address is
  closed with `4007` until the window ends; the log shows one warning per address and window. A secret Twitch
  rejected is also refused for 60 seconds without asking Twitch again.

IPv4 counts per address, IPv6 per /64 – one host usually owns a whole /64 and could otherwise use a fresh address
for every attempt. Change `GATEWAY_IPV6_PREFIX_LENGTH` if your clients share a /64 but are different hosts (e.g.
several apps on one IPv6 network: a longer prefix such as `128` counts every address on its own), or if attackers
get larger networks (a shorter prefix such as `56` or `48`).

Without a correct `TRUSTED_PROXIES` all clients behind your proxy count as one address, so a single misconfigured app
could lock out every other one.

## 6. Check that everything works

**Health:**

```bash
curl https://api.example.com/health
# {"status":"ok", …, "checks":{"redis":{"ok":true,"latencyMs":0.4},"gateway":{"ok":true}}, …}
```

**A client:** with a checkout of this repository and [Bun](https://bun.com) (or Node.js ≥ 22), connect the example
client with the credentials of any Twitch app (from the [Twitch Developer Console](https://dev.twitch.tv/console/apps)):

```bash
GATEWAY_URL=wss://gateway.example.com \
TWITCH_CLIENT_ID=<client id> \
TWITCH_CLIENT_SECRET=<client secret> \
TWITCH_BOT_USER_ID=<optional: user id of your bot> \
EVENTS=<optional: e.g. stream.online,channel.chat.message> \
bun examples/gateway-client.mjs
# READY – session 2b6c3e64-…, 0 authorized user(s)
```

**A webhook** with the [Twitch CLI](https://dev.twitch.tv/docs/cli/), signed with your secret. The callback URL needs
`?client_id=` with the client id of a connected app – that's how the gateway knows which app an event belongs to (the
real conduit shards are set up exactly like that). Events without it, or for an app without sessions, reach no client.

```bash
# the gateway answers the subscription challenge
twitch event verify-subscription stream.online \
  -F "https://api.example.com/twitch/webhook/callback?client_id=<client id>" -s "<TWITCH_WEBHOOK_SECRET>"

# a test event – the example client prints "#1 STREAM_ONLINE"
twitch event trigger stream.online -t <any user id> \
  -F "https://api.example.com/twitch/webhook/callback?client_id=<client id>" -s "<TWITCH_WEBHOOK_SECRET>"
```

## 7. Connect an app

For app developers, in short:

1. Connect to `wss://gateway.example.com/?v=1&encoding=json` and send IDENTIFY with the client id and secret of your
   Twitch app, optionally `botUserId` (needed for chat events via `channel:bot`) and an `events` filter.
2. Users authorize your app as usual via OAuth with the scopes you need. The gateway receives the
   `user.authorization.grant` and subscribes to every event those scopes allow – nothing else to do. Link, scopes and
   chat bots: [authorizing users](AUTHORIZATION.md).
3. Events arrive as DISPATCH; after a disconnect, RESUME replays what was missed.

The gateway only learns about users through `user.authorization.grant`: users who authorized your app **before** it
first connected to the gateway have to authorize it again. Everything about the protocol is in
[`GATEWAY.md`](GATEWAY.md).

## 8. Without Docker

Every [release](https://github.com/twive-app/eventsub-gateway/releases) has standalone executables for Linux (glibc):
`eventsub-gateway-linux-x64` and `eventsub-gateway-linux-arm64`, plus `checksum.txt`. They need no Bun
installation.

```bash
VERSION=v1.2.3   # the release you want
curl -fsSLO "https://github.com/twive-app/eventsub-gateway/releases/download/$VERSION/eventsub-gateway-linux-x64"
curl -fsSLO "https://github.com/twive-app/eventsub-gateway/releases/download/$VERSION/checksum.txt"
sha256sum --check --ignore-missing checksum.txt
sudo install -m 755 eventsub-gateway-linux-x64 /usr/local/bin/eventsub-gateway
eventsub-gateway --version
```

Redis: e.g. the distribution's `redis-server` (≥ 7.2) with `appendonly yes` in its configuration. Then a system user,
the configuration (same variables as `.env.example`) and a systemd unit:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin twive
sudo install -m 600 .env /etc/eventsub-gateway.env    # .env.example with the REQUIRED block filled in
```

`/etc/systemd/system/eventsub-gateway.service`:

```ini
[Unit]
Description=EventSub Gateway
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
User=twive
Group=twive
EnvironmentFile=/etc/eventsub-gateway.env
ExecStart=/usr/local/bin/eventsub-gateway
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eventsub-gateway
journalctl -u eventsub-gateway -f
```

## 9. Updating

```bash
docker compose pull gateway
docker compose up -d gateway
```

The old container gets SIGTERM: it sends RECONNECT to every client, keeps their sessions resumable in Redis and exits
within a few seconds. The clients connect to the new one, RESUME and get the events they missed. Without Docker:
replace the executable and `sudo systemctl restart eventsub-gateway`.

Exactly **one** gateway instance runs per Redis database – never start the new one next to the old one against the same
Redis. To pin a version, use the image tag `vX.Y.Z` instead of `latest` (see [image tags](#image-tags)).

### Image tags

The image `ghcr.io/twive-app/eventsub-gateway` (`linux/amd64`, `linux/arm64`) contains nothing but the gateway compiled
into one executable on `gcr.io/distroless/cc-debian13:nonroot` – no shell, no package manager, runs as a non-root user.

| Image tag  | Contents                                                              | Version (start log, `/health`) |
|------------|-----------------------------------------------------------------------|--------------------------------|
| `latest`   | latest published, non-prerelease release; rebuilt weekly (base image) | `1.2.3`                        |
| `v1.2.3`   | exactly this release (also prereleases like `v1.3.0-rc.1`), rebuilt weekly while it is the latest release | `1.2.3` |
| `alpha` / `beta` / `rc` | latest prerelease of that channel (e.g. `v1.3.0-beta.2`)  | `1.3.0-beta.2`                 |
| `dev`      | latest commit on `dev` (development, will break)                      | `1.2.3-dev.<commit>`           |

Local builds (`docker compose up --build`) report the version `0.0.0`. The version of an image:
`docker run --rm ghcr.io/twive-app/eventsub-gateway:latest --version`.

## 10. Monitoring

`GET /health` answers `200` with `"status": "ok"` when every check passes, otherwise `503` with `"status": "degraded"`.
The Redis check is a real `PING` (1 s timeout); the gateway check tells whether the WebSocket server is listening.

```json
{
  "status": "ok",
  "version": "1.2.3",
  "uptime": 123,
  "checks": {
    "redis": {"ok": true, "latencyMs": 2},
    "gateway": {"ok": true}
  },
  "gateway": {"connections": 3, "sessions": 5, "applications": 2}
}
```

The gateway works with any uptime monitor – pull (`GET /health`) or push (`HEALTH_PUSH_URL`). With
[Uptime Kuma](https://github.com/louislam/uptime-kuma):

- **HTTP(s) – JSON Query:** URL `https://<host>/health`, JSON query `status`, expected value `ok`. A plain HTTP(s)
  monitor works as well – `503` counts as down.
- **Push:** create a Push monitor and set the URL it shows – completely, including `?status=up&msg=OK&ping=` – as
  `HEALTH_PUSH_URL`. Choose its heartbeat interval a bit larger than `HEALTH_PUSH_INTERVAL` (e.g. 70 s for the default
  60 s). While healthy the gateway reports `status=up` with the Redis latency as `ping`, while unhealthy `status=down`
  with the reason in `msg`.
- **WebSocket:** to watch the WebSocket port as well, add a TCP port monitor on `GATEWAY_PORT` or – if your Kuma
  version has it – a WebSocket monitor on `wss://<gateway-host>/?v=1&encoding=json`.

The same works with Healthchecks.io, Better Stack and similar services: a push URL without query parameters is only
called while the gateway is healthy, so a missing ping raises the alarm. The URL contains a token – the gateway logs
only its host; use `HEALTH_PUSH_URL_FILE` to keep it in a Docker secret.

The Docker image also has a `HEALTHCHECK` (`/app/gateway healthcheck` asks `GET /health`; `docker compose ps` shows
`healthy`).

## 11. Troubleshooting

**The gateway doesn't start.** It exits with code 1 and one message naming every variable that is missing or invalid,
e.g. `missing required variables: TWITCH_WEBHOOK_CALLBACK_URL, TWITCH_WEBHOOK_SECRET (or TWITCH_WEBHOOK_SECRET_FILE)`.
Look at `docker compose logs gateway`.

**Clients are closed with `4004`.** The reason says what's wrong: `Invalid clientId or clientSecret` – the app's client
id/secret from the Twitch Developer Console (not the webhook secret); `Invalid botUserId` – the user id doesn't exist.
If Twitch is unreachable, clients get INVALID_SESSION "Twitch is unavailable, try again later" instead.

**Clients are closed with `4007`.** The reason says which limit: `Too many connections from your address`,
`Too many connections, try again later` or `Too many failed authentication attempts, try again later` – see
[connection limits](#connection-limits). If all clients are affected at once, `TRUSTED_PROXIES` is probably missing
(the log shows the proxy's address for every connection).

**Events don't arrive.** Go through this list – the requests need an app access token:

```bash
TOKEN=$(curl -s -X POST https://id.twitch.tv/oauth2/token \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&grant_type=client_credentials" | jq -r .access_token)
H=(-H "Authorization: Bearer $TOKEN" -H "Client-Id: $CLIENT_ID")
```

1. **Subscription:** `curl "${H[@]}" "https://api.twitch.tv/helix/eventsub/subscriptions?user_id=<user id>"` – does it
   exist, is its `status` `enabled`, and is `transport.conduit_id` the conduit from READY (`application.conduitId`)?
2. **Shard:** `curl "${H[@]}" "https://api.twitch.tv/helix/eventsub/conduits/shards?conduit_id=<conduit id>"` – is it
   `enabled`, and is `transport.callback` your `TWITCH_WEBHOOK_CALLBACK_URL` with `?client_id=<client id>`? A disabled
   shard (e.g. after the callback was unreachable) is written again on the first IDENTIFY after a gateway restart.
3. **Webhook:** with `LOG_DEBUG=true` the gateway logs every notification it receives. `Invalid signature` means a
   different secret (see [section 3](#3-webhook-secret)); messages older than 10 minutes and duplicates are dropped
   with a log line as well. Nothing at all: Twitch doesn't reach your callback – check DNS, TLS and the proxy.
4. **Event filter:** a session that sent `events` in IDENTIFY only receives those events.
5. **Scopes:** has the user authorized your app with the scope the event needs?
   `curl "${H[@]}" "https://api.twitch.tv/helix/authorization/users?user_id=<user id>"` lists the granted scopes. Users
   who authorized the app before it connected to the gateway have to authorize again ([section 7](#7-connect-an-app)).

## 12. Pelican Panel

The gateway can run as a server in the [Pelican Panel](https://pelican.dev) with the egg
[`pelican/egg-eventsub-gateway.yaml`](../pelican/egg-eventsub-gateway.yaml). It uses the same Docker image
as above (*Stable* = `latest`, *Beta* = `beta`, *Development* = `dev`); the panel can update the egg itself from its
update URL.

1. **Import the egg:** *Admin* → *Eggs* → *Import* → *URL*
   `https://raw.githubusercontent.com/twive-app/eventsub-gateway/main/pelican/egg-eventsub-gateway.yaml` (or
   upload the file).
2. **Redis:** the egg contains only the gateway. Run a Redis ≥ 7.2 **with persistence** (AOF) – e.g. as its own server
   with a Redis egg or outside the panel – and enter host, port, password and database in the server's variables. The
   gateway must be able to reach it from its container (with a Redis server in the same panel: the IP of its
   allocation, not `localhost`).
3. **Two allocations:** the **primary** allocation is the HTTP port (webhook callback, `GET /health` – the gateway
   reads it as `SERVER_PORT`). Add a **second** allocation and enter its port as *WebSocket port* (`GATEWAY_PORT`).
4. **Webhook:** set *Webhook callback URL* and *Webhook secret* ([section 3](#3-webhook-secret)).
5. **Reverse proxy and TLS** in front of both allocations as in [section 5](#5-reverse-proxy-and-tls) – the panel
   publishes them as plain HTTP/WS. Set *Trusted proxies* to the address your proxy connects from
   ([client addresses](#client-addresses-trusted_proxies)).
6. **Start the server.** The console shows the log; the panel marks the server as running at
   `Gateway is now running!`. *Stop* sends SIGTERM: clients get RECONNECT and RESUME after the next start.

All other variables keep their defaults ([configuration](CONFIGURATION.md)). Server users with access to the
*Startup* tab can see the webhook secret and the Redis password – only give access to people you trust with them.

