// Minimal EventSub Gateway client: heartbeats, automatic RESUME, sequence check and reconnect with backoff.
//
//   TWITCH_CLIENT_ID=… TWITCH_CLIENT_SECRET=… TWITCH_BOT_USER_ID=123456789 bun examples/eventsub-gateway-client.mjs
//
// Optional: GATEWAY_URL – URL of the gateway to connect to, also for RESUME (default ws://localhost:3001),
//           SUBSCRIPTION_TYPES – only subscribe to these for authorized users, EVENTS – only receive these
//           (both comma separated, e.g. "channel.chat.message,stream.online").
// Uses the global WebSocket (Bun, Node ≥ 22, browsers) – no dependencies.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "ws://localhost:3001";
const credentials = {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
};

if (!credentials.clientId || !credentials.clientSecret) {
    console.error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
    process.exit(1);
}

const Op = {Hello: 0, Identify: 1, Resume: 2, Dispatch: 3, Heartbeat: 4, HeartbeatAck: 5, Reconnect: 6, InvalidSession: 7};
// Don't reconnect: wrong credentials/bot, unsupported version, unknown events/types, session resumed elsewhere.
const fatalCloseCodes = new Set([4004, 4009, 4010, 4011]);
// Reconnect, but with a new session (IDENTIFY instead of RESUME).
const newSessionCloseCodes = new Set([4003, 4006]);

let sessionId = null;
let sequence = null;
// The app access token for your own Helix calls – READY hands it over, RESUMED the renewed one.
let accessToken = null;
let reconnectAttempts = 0;

/** IDENTIFY data – the same for the first IDENTIFY and every new one after INVALID_SESSION. */
function identifyData() {
    return {
        ...credentials,
        botUserId: process.env.TWITCH_BOT_USER_ID || undefined,
        subscriptionTypes: process.env.SUBSCRIPTION_TYPES ? process.env.SUBSCRIPTION_TYPES.split(",") : undefined,
        events: process.env.EVENTS ? process.env.EVENTS.split(",") : undefined,
    };
}

/** Wait before the next connect: 1 s, 2 s, 4 s … up to 30 s, plus up to 1 s at random. */
function reconnectDelay() {
    return Math.min(1000 * 2 ** reconnectAttempts++, 30000) + Math.random() * 1000;
}

function connect() {
    const ws = new WebSocket(`${GATEWAY_URL}/?v=1`);
    const send = (op, d = null) => ws.send(JSON.stringify({op, d}));
    let heartbeatTimer = null;
    let acknowledged = true;

    ws.addEventListener("message", (event) => {
        const {op, d, s, t} = JSON.parse(String(event.data));

        // Sequence numbers arrive without gaps – a gap means missed events: reconnect, RESUME replays them.
        if (s !== null) {
            if (sequence !== null && s > sequence + 1) {
                console.warn(`Gap in the sequence (${sequence} → ${s}), resuming`);
                return ws.close(4000, "sequence gap");
            }
            if (sequence !== null && s <= sequence) return;
            sequence = s;
        }

        switch (op) {
            case Op.Hello:
                heartbeatTimer = setInterval(() => {
                    // No HEARTBEAT_ACK since the last heartbeat: the connection is dead – reconnect and RESUME.
                    if (!acknowledged) return ws.close(4000, "no heartbeat ack");
                    acknowledged = false;
                    send(Op.Heartbeat, sequence);
                }, d.heartbeatInterval);

                if (sessionId) send(Op.Resume, {...credentials, sessionId, seq: sequence ?? 0});
                else send(Op.Identify, identifyData());
                break;

            case Op.HeartbeatAck:
                acknowledged = true;
                break;

            case Op.Dispatch:
                switch (t) {
                    case "READY":
                        sessionId = d.sessionId;
                        accessToken = d.application.accessToken;
                        reconnectAttempts = 0;
                        console.log(`READY – session ${sessionId}, ${d.authorizedUserIds.length} authorized user(s)`);
                        break;

                    case "RESUMED":
                        if (d.accessToken !== accessToken) console.log("App access token renewed");
                        accessToken = d.accessToken;
                        reconnectAttempts = 0;
                        console.log(`RESUMED – ${d.replayed} missed event(s) replayed`);
                        break;

                    case "SUBSCRIPTION_FAILED":
                        console.warn(`#${s} SUBSCRIPTION_FAILED ${d.type} (${d.status ?? "no answer"}): ${d.message}`, d.condition);
                        break;

                    case "USER_SUBSCRIBED":
                        const failed = d.failed.length > 0 ? `, failed: ${d.failed.join(", ")}` : "";
                        console.log(`#${s} USER_SUBSCRIBED ${d.userId} (${d.reason}) – ${d.events.length} event(s)${failed}`);
                        break;

                    case "SUBSCRIPTION_REVOKED":
                        console.warn(`#${s} SUBSCRIPTION_REVOKED ${d.type}: ${d.status}`, d.condition);
                        break;

                    default:
                        console.log(`#${s} ${t}`, d);
                }
                break;

            case Op.Reconnect:
                // The server closes right after (1012 or 4012) – the close handler reconnects and RESUMEs.
                console.log("RECONNECT requested");
                break;

            case Op.InvalidSession:
                console.warn("INVALID_SESSION:", d.message);
                sessionId = null;
                sequence = null;
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) send(Op.Identify, identifyData());
                }, 1000 + Math.random() * 4000);
                break;
        }
    });

    ws.addEventListener("close", ({code, reason}) => {
        clearInterval(heartbeatTimer);
        console.warn(`Connection closed: ${code} ${reason}`);

        if (fatalCloseCodes.has(code)) process.exit(1);
        if (newSessionCloseCodes.has(code)) {
            sessionId = null;
            sequence = null;
        }

        setTimeout(connect, reconnectDelay());
    });

    ws.addEventListener("error", () => console.error("Socket error"));
}

connect();
