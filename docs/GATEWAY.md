# Gateway documentation

The EventSub Gateway delivers Twitch EventSub events to your app over a single WebSocket – no public webhook
endpoint, no conduit management, no subscription bookkeeping.

```
wss://<gateway-host>/?v=1
```

The host is the one of your gateway – e.g. `wss://gateway.example.com` behind your reverse proxy (see the
[setup guide](SETUP.md)), locally `ws://localhost:3001`. To RESUME, you connect to the same URL again.

| Query parameter | Value | Required    | Description                                                                                     |
|-----------------|-------|:-----------:|-------------------------------------------------------------------------------------------------|
| `v`             | `1`   | recommended | API version your client speaks – without it, you always get the latest version. Any other value closes the connection with [`4009`](#close-codes) |

Always send `v`: when a future version changes the protocol, a client that asks for `v=1` gets a clear `4009` instead
of silently breaking.

## How it works

1. You connect and **IDENTIFY** with the client id + secret of your Twitch application.
2. The gateway creates an EventSub [conduit](https://dev.twitch.tv/docs/eventsub/handling-conduit-events/) for your
   application, subscribes to `user.authorization.grant`/`revoke` and points the conduit to its own webhook.
3. Whenever a user authorizes your application, the gateway subscribes to every event the granted scopes allow.
4. Every EventSub notification is forwarded to all sessions of your application as a **DISPATCH**.

If no client of your application is connected for a while (30 days by default), the gateway deletes its conduit and
Twitch stops sending events. Your next IDENTIFY sets everything up again – only users who authorized your application
in between have to authorize it again. After a longer time (180 days by default) the gateway forgets your application
completely, and all users have to authorize it again (see [inactive apps](SETUP.md#inactive-apps)).

## Payloads

Every frame is a JSON text message (up to 4 KiB by default):

| Field | Type             | Description                                                  |
|-------|------------------|--------------------------------------------------------------|
| `op`  | integer          | [Opcode](#opcodes)                                           |
| `d`   | any \| null      | Payload data                                                 |
| `s`   | integer \| null  | Sequence number – only for sequenced DISPATCH events         |
| `t`   | string \| null   | Event name – only for DISPATCH                               |

The server always sends all four fields; you only need to send `op` and `d`.

## Opcodes

| Code | Name            | Direction | Description                                               |
|------|-----------------|-----------|-----------------------------------------------------------|
| 0    | HELLO           | ←         | Sent right after connecting                               |
| 1    | IDENTIFY        | →         | Start a new session                                       |
| 2    | RESUME          | →         | Resume a disconnected session                             |
| 3    | DISPATCH        | ←         | An event was dispatched                                   |
| 4    | HEARTBEAT       | →         | Keep the connection alive                                 |
| 5    | HEARTBEAT_ACK   | ←         | Acknowledges a HEARTBEAT                                  |
| 6    | RECONNECT       | ←         | Reconnect and RESUME (e.g. the gateway restarts)          |
| 7    | INVALID_SESSION | ←         | IDENTIFY/RESUME did not work, IDENTIFY again              |

## Connection lifecycle

```
client                                   gateway
  | ---------- connect -------------------> |
  | <--------- HELLO {heartbeatInterval} -- |
  | ---------- IDENTIFY ------------------> |
  | <--------- DISPATCH READY ------------- |
  | ---------- HEARTBEAT (every interval) > |
  | <--------- HEARTBEAT_ACK -------------- |
  | <--------- DISPATCH CHANNEL_… (s=1) --- |
```

### HELLO (op 0)

```json
{"op": 0, "d": {"heartbeatInterval": 41250}, "s": null, "t": null}
```

### HEARTBEAT (op 4)

Send a heartbeat every `heartbeatInterval` milliseconds (41250 by default). `d` is the last sequence number you
received, or `null`. The server answers every heartbeat with HEARTBEAT_ACK (op 5). Once you are identified and no
heartbeat arrives for 1.5 × `heartbeatInterval`, the server closes the connection with `4008`; the session stays
resumable.

```json
{"op": 4, "d": 42}
```

### IDENTIFY (op 1)

Send IDENTIFY or RESUME within 30 seconds after connecting, otherwise the connection is closed with `4003`.

```json
{
  "op": 1,
  "d": {
    "clientId": "your twitch client id",
    "clientSecret": "your twitch client secret",
    "botUserId": "123456789",
    "events": ["CHANNEL_CHAT_MESSAGE", "STREAM_ONLINE"]
  }
}
```

| Field          | Required | Description                                                                                   |
|----------------|----------|-----------------------------------------------------------------------------------------------|
| `clientId`     | yes      | Client id of your Twitch application                                                          |
| `clientSecret` | yes      | Client secret – only used to obtain an app access token, the gateway stores a hash, never the secret |
| `botUserId`    | no       | User id of your bot account – needed for chat events via the `channel:bot` scope. Omit it to keep the stored value, send `null` to remove it. An unknown user closes the connection with `4004` |
| `events`       | no       | Only receive these events (dispatch name or EventSub type, up to 250). Omit to receive everything. An unknown name closes the connection with `4010` |

The answer is READY, or INVALID_SESSION if the application could not be set up. Wrong credentials close the
connection with `4004`; if Twitch can't be reached to check them, you get INVALID_SESSION "Twitch is unavailable, try
again later" instead – your credentials are fine, IDENTIFY again after a few seconds.

The bot belongs to your application, not to the session: every session of the application uses the last `botUserId`
that was sent. You get the id with `GET https://api.twitch.tv/helix/users?login=<bot>`, or you already know it as
`sender_id` from `POST /helix/chat/messages`. When it changes, the chat subscriptions of all users move to the new bot
in the background.

### READY (DISPATCH)

```json
{
  "op": 3,
  "t": "READY",
  "s": null,
  "d": {
    "v": 1,
    "sessionId": "2b6c3e64-…",
    "application": {
      "clientId": "…",
      "botUserId": "123456789",
      "conduitId": "…",
      "accessToken": "app access token"
    },
    "authorizedUserIds": ["111", "222"],
    "events": null
  }
}
```

| Field                      | Description                                                                 |
|----------------------------|-----------------------------------------------------------------------------|
| `v`                        | API version of the connection                                               |
| `sessionId`                | Your session – keep it for RESUME                                           |
| `application.botUserId`    | User id of your bot account, or `null`                                      |
| `application.conduitId`    | The EventSub conduit the gateway manages for your application               |
| `application.accessToken`  | A valid app access token for your own Helix calls                           |
| `authorizedUserIds`        | Users who have authorized your application so far                           |
| `events`                   | Your event filter as dispatch names, or `null` for all events               |

Store `sessionId` and the last `s` you received – you need both to RESUME.

### DISPATCH events

Every EventSub subscription type becomes an event name: upper case, dots replaced by underscores.
`d` is the `event` object of the EventSub notification, unchanged.

| EventSub type                | Dispatch event                 |
|------------------------------|--------------------------------|
| `channel.chat.message`       | `CHANNEL_CHAT_MESSAGE`         |
| `stream.online`              | `STREAM_ONLINE`                |
| `user.authorization.grant`   | `USER_AUTHORIZATION_GRANT`     |
| …                            | …                              |

Additional gateway events:

| Event                  | Sequenced | Description                                                                |
|------------------------|-----------|----------------------------------------------------------------------------|
| `READY`                | no        | Answer to IDENTIFY                                                         |
| `RESUMED`              | no        | Answer to RESUME, after all missed events were replayed (`d`: sessionId, replayed) |
| `SUBSCRIPTION_REVOKED` | yes       | Twitch revoked a subscription (`d`: id, type, version, status, condition)  |

Sequence numbers start at 1, are counted per session and arrive without gaps. If you ever see a gap in `s`, close
the connection (e.g. with `4000`), connect again and RESUME with the last `s` you received.

### RESUME (op 2)

If the connection drops, connect to the same URL again and send RESUME instead of IDENTIFY. The server replays every
event you missed in order, with its original `s`, followed by `RESUMED`.

```json
{
  "op": 2,
  "d": {
    "clientId": "…",
    "clientSecret": "…",
    "sessionId": "2b6c3e64-…",
    "seq": 42
  }
}
```

`seq` is the last sequence number you received (`0` if none). A session stays resumable for 2 minutes after its
connection closed, also across gateway restarts. The server keeps the last 500 events per session; if you missed
more, or the session expired, you receive INVALID_SESSION. If the session is still attached to another connection,
that connection is closed with `4011`. (2 minutes and 500 events are the defaults, see `GATEWAY_RESUME_TIMEOUT` and
`GATEWAY_REPLAY_BUFFER_SIZE` in the [configuration](CONFIGURATION.md).)
As with IDENTIFY, wrong credentials close the connection with `4004`, and a Twitch outage answers with INVALID_SESSION
"Twitch is unavailable, try again later".

### RECONNECT (op 6)

The gateway is about to restart: right after RECONNECT the server closes the connection with `1012`. Connect again and
RESUME.

### INVALID_SESSION (op 7)

```json
{"op": 7, "d": {"resumable": false, "message": "Session not found or expired, IDENTIFY again"}, "s": null, "t": null}
```

The server sends this when IDENTIFY or RESUME did not work (session expired, too many missed events, the application
could not be set up, Twitch or the gateway is temporarily unavailable). `resumable` is currently always `false`. The connection
stays open and the 30 seconds for IDENTIFY start again – wait 1–5 seconds and send a fresh IDENTIFY.

## Close codes

| Code | Name                  | Session            | What to do                    | Description                                                   |
|------|-----------------------|--------------------|-------------------------------|---------------------------------------------------------------|
| 4000 | Unknown error         | resumable          | RESUME                        | Something went wrong, or your client reads too slowly (below)  |
| 4001 | Unknown opcode        | resumable          | RESUME                        | You sent an invalid opcode                                    |
| 4002 | Decode error          | resumable          | RESUME                        | Invalid JSON or payload shape                                 |
| 4003 | Not authenticated     | –                  | IDENTIFY/RESUME in time       | No IDENTIFY/RESUME within 30 seconds                          |
| 4004 | Authentication failed | unchanged          | fix the credentials           | Invalid `clientId`, `clientSecret` or `botUserId`             |
| 4005 | Already authenticated | resumable          | RESUME                        | IDENTIFY/RESUME sent twice or while one is still in progress  |
| 4006 | Invalid seq           | ends               | IDENTIFY                      | `seq` of RESUME is higher than the session's sequence         |
| 4007 | Rate limited          | resumable / –      | send less / back off          | More than 120 payloads per minute (default), or a connection limit (below) |
| 4008 | Heartbeat timeout     | resumable          | RESUME                        | No HEARTBEAT within 1.5 × `heartbeatInterval`                 |
| 4009 | Invalid API version   | –                  | fix `v`                       | Unsupported `v` query parameter                               |
| 4010 | Invalid events        | –                  | fix `events`                  | Unknown event name in `events`                                |
| 4011 | Session replaced      | moved              | don't reconnect               | The session was resumed on another connection                 |
| 1012 | Service restart       | resumable          | RESUME                        | The gateway restarts (sent after RECONNECT)                   |

**Reading too slowly:** the server buffers frames your client hasn't read yet. If it falls behind by more than half
the replay buffer (250 events by default), the server closes the connection with `4000` ("Client too slow, RESUME")
while the gap still fits into the replay buffer. Reconnect and RESUME with the last `s` you received – you get every
missed event. If you resume too late and the gap no longer fits, you receive INVALID_SESSION and IDENTIFY again.

**Connection limits:** `4007` right after connecting – before HELLO – means the server rejected the connection
itself. The reason says why: `Too many connections from your address`, `Too many connections, try again later` (the
gateway is full) or `Too many failed authentication attempts, try again later` (too many IDENTIFY/RESUME with a wrong
`clientSecret` or unknown `botUserId` from your address; the block lasts up to 10 minutes by default). Reconnect with
an exponential backoff (e.g. 1 s, 2 s, 4 s … up to a few minutes) instead of right away – every immediate retry is
rejected again. A `4007` for sending too many payloads keeps your session: reconnect and RESUME.

"–" means the connection had no session yet. If you close the connection yourself with `1000` or `1001`, the session
ends – use any other code (e.g. `4000`) if you want to RESUME afterward.

## Example client

See [`examples/gateway-client.mjs`](../examples/gateway-client.mjs) for a complete client with heartbeats and
automatic resuming.
