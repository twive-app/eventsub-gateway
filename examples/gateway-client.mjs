// Minimal EventSub Gateway client with heartbeats and automatic RESUME.
//
//   TWITCH_CLIENT_ID=… TWITCH_CLIENT_SECRET=… TWITCH_BOT_USER_ID=123456789 bun examples/gateway-client.mjs
//
// Optional: GATEWAY_URL – URL of the gateway to connect to, also for RESUME (default ws://localhost:3001),
//           EVENTS (comma separated, e.g. "channel.chat.message").
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
const fatalCloseCodes = new Set([4004, 4009, 4010, 4011]);
const newSessionCloseCodes = new Set([4003, 4006]);

let sessionId = null;
let sequence = null;
let heartbeatTimer = null;

function connect() {
    const ws = new WebSocket(`${GATEWAY_URL}/?v=1`);
    const send = (op, d = null) => ws.send(JSON.stringify({op, d}));

    ws.addEventListener("message", (event) => {
        const {op, d, s, t} = JSON.parse(String(event.data));
        if (s !== null) sequence = s;

        switch (op) {
            case Op.Hello:
                clearInterval(heartbeatTimer);
                heartbeatTimer = setInterval(() => send(Op.Heartbeat, sequence), d.heartbeatInterval);

                if (sessionId) {
                    send(Op.Resume, {...credentials, sessionId, seq: sequence ?? 0});
                } else {
                    send(Op.Identify, {
                        ...credentials,
                        botUserId: process.env.TWITCH_BOT_USER_ID || undefined,
                        events: process.env.EVENTS ? process.env.EVENTS.split(",") : undefined,
                    });
                }
                break;

            case Op.Dispatch:
                if (t === "READY") {
                    sessionId = d.sessionId;
                    console.log(`READY – session ${sessionId}, ${d.authorizedUserIds.length} authorized user(s)`);
                } else if (t === "RESUMED") {
                    console.log(`RESUMED – ${d.replayed} missed event(s) replayed`);
                } else {
                    console.log(`#${s} ${t}`, d);
                }
                break;

            case Op.Reconnect:
                ws.close(4000, "reconnect requested");
                break;

            case Op.InvalidSession:
                console.warn("INVALID_SESSION:", d.message);
                sessionId = null;
                sequence = null;
                setTimeout(() => send(Op.Identify, {...credentials, botUserId: process.env.TWITCH_BOT_USER_ID || undefined}), 1000 + Math.random() * 4000);
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

        setTimeout(connect, 1000);
    });

    ws.addEventListener("error", () => console.error("Socket error"));
}

connect();
