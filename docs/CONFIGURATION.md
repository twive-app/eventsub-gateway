# Configuration

The gateway is configured through environment variables. [`.env.example`](../.env.example) lists all of them
with comments – copy it to `.env`.

- **Where `.env` is read:** Bun loads it automatically from the working directory (`bun run dev`); `compose.yml` passes
  it to the container.
- **Empty values** count as unset, so the default applies.
- **Secrets from files** (e.g. Docker secrets): instead of `TWITCH_WEBHOOK_SECRET`, `REDIS_PASSWORD` or
  `HEALTH_PUSH_URL`, set `<NAME>_FILE` to the path of a file that contains the value. Setting both is an error.
- **Invalid or missing values** stop the gateway on startup (exit code 1) with one message that lists every affected
  variable:
  ```
  missing required variables: TWITCH_WEBHOOK_CALLBACK_URL, TWITCH_WEBHOOK_SECRET (or TWITCH_WEBHOOK_SECRET_FILE)
  ```

| Variable | Default | Required | Description |
|---|---|---|---|
| `ENVIRONMENT` | `prod` | no | Name of the environment, shown on startup |
| `TZ` | system (`UTC` in Docker) | no | Time zone of log timestamps, e.g. `Europe/Berlin` |
| `REDIS_HOST` | `localhost` | no | Redis host |
| `REDIS_PORT` | `6379` | no | Redis port |
| `REDIS_USERNAME` | – | no | Redis ACL user |
| `REDIS_PASSWORD` / `…_FILE` | – | no | Redis password |
| `REDIS_DB` | `0` | no | Database number |
| `REDIS_KEY_PREFIX` | – | no | Prefix of every key, e.g. `twive` or `twive:prod` (letters, digits, `_`, `.`, `-`; `:` between parts) – for a Redis database shared with other applications |
| `SERVER_HOST` | `0.0.0.0` | no | Bind address of the HTTP server (and of the gateway, see below) |
| `SERVER_PORT` | `3000` | no | HTTP port: webhook callback, `/health` |
| `TRUSTED_PROXIES` | none | no | Reverse proxies whose `X-Forwarded-For` is trusted: IPs and CIDRs, comma separated (e.g. `127.0.0.1,::1`, `172.16.0.0/12`) – see [client addresses](SETUP.md#client-addresses-trusted_proxies) |
| `GATEWAY_HOST` | `SERVER_HOST` | no | Bind address of the WebSocket gateway |
| `GATEWAY_PORT` | `3001` | no | Port of the WebSocket gateway – put it behind your domain / reverse proxy (e.g. `wss://gateway.example.com`) |
| `GATEWAY_HEARTBEAT_INTERVAL` | `41250` | no | Heartbeat interval in ms (≥ 5000) |
| `GATEWAY_IDENTIFY_TIMEOUT` | `30000` | no | Time to IDENTIFY/RESUME after connecting in ms (≥ 1000) |
| `GATEWAY_RESUME_TIMEOUT` | `120000` | no | How long a disconnected session stays resumable in ms (0 = never) |
| `GATEWAY_REPLAY_BUFFER_SIZE` | `500` | no | Events kept per session for RESUME |
| `GATEWAY_MAX_PAYLOAD_SIZE` | `4096` | no | Max size of a client message in bytes (≥ 512) |
| `GATEWAY_RATE_LIMIT_MAX_MESSAGES` | `120` | no | Max client messages per window |
| `GATEWAY_RATE_LIMIT_WINDOW_MS` | `60000` | no | Rate limit window in ms (≥ 1000) |
| `GATEWAY_MAX_CONNECTIONS` | `0` | no | Max connections in total (0 = unlimited) |
| `GATEWAY_MAX_CONNECTIONS_PER_IP` | `100` | no | Max simultaneous connections per client address (0 = unlimited) |
| `GATEWAY_IPV6_PREFIX_LENGTH` | `64` | no | The per-address limits count IPv6 clients per prefix of this length (32–128, `128` = every address on its own); IPv4 always per address |
| `GATEWAY_AUTH_FAILURE_LIMIT` | `10` | no | Failed IDENTIFY/RESUME per client address and window; then its connections are closed with `4007` until the window ends (0 = off) |
| `GATEWAY_AUTH_FAILURE_WINDOW_MS` | `600000` | no | Window of `GATEWAY_AUTH_FAILURE_LIMIT` in ms (≥ 1000) |
| `HEALTH_PUSH_URL` / `…_FILE` | – | no | Push monitor URL the gateway calls while healthy (`http`/`https`); empty = off – see [Monitoring](SETUP.md#10-monitoring) |
| `HEALTH_PUSH_INTERVAL` | `60` | no | Interval of the health push in seconds (≥ 10) |
| `LOG_DEBUG` | `false` | no | Debug logs (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`) |
| `TWITCH_WEBHOOK_CALLBACK_URL` | – | **yes** | Public HTTPS URL of `POST /twitch/webhook/callback` |
| `TWITCH_WEBHOOK_SECRET` / `…_FILE` | – | **yes** | HMAC secret for EventSub (10–100 characters) |

## Redis

The gateway uses Redis as the datastore – applications, app access tokens, authorized users, gateway sessions and connections.

- Use Redis ≥ 7.2 **with persistence** (AOF: `appendonly yes`, `appendfsync everysec`). Without it a Redis restart
  forgets every application, and every app gets a new conduit on its next IDENTIFY. The Redis in `compose.yml` has AOF
  enabled.
- Keys live in the two folders `twitch:…` and `gateway:…`. If the Redis is shared, give the gateway its own database
  number (`REDIS_DB`) or a `REDIS_KEY_PREFIX` – with `twive` the keys become `twive:twitch:…` and `twive:gateway:…`.
  Changing the prefix (or the database) later starts from an empty state: the old keys stay where they are.
- Exactly **one** gateway instance runs per Redis database. Two instances at the same time against the same database
  are not supported – among other things, each instance caches the conduit id of every application in memory.
