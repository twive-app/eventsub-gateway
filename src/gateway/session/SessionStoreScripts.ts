import {GatewayOpCode} from "@gateway/GatewayProtocol.ts";

// The Lua scripts of SessionStore – each runs atomically in Redis; every key is passed in KEYS, never built inside.

// Fans one event out to every session of an app: filter, sequence number and replay buffer, atomically.
const dispatch: string = `
local results = {}
local sequenced = ARGV[3] == "1"
local bufferSize = tonumber(ARGV[4])
local count = (#KEYS - 1) / 3
local payloadHead = '{"op":${GatewayOpCode.Dispatch},"d":' .. ARGV[2] .. ',"s":'
local payloadTail = ',"t":' .. cjson.encode(ARGV[1]) .. '}'
for i = 1, count do
    local session, seqKey, bufferKey = KEYS[i * 3 - 1], KEYS[i * 3], KEYS[i * 3 + 1]
    local sessionId = ARGV[4 + i]
    local raw = redis.call("GET", session)
    if not raw then
        -- the session expired: drop it from the index
        redis.call("SREM", KEYS[1], sessionId)
    else
        local data = cjson.decode(raw)
        local wants = (not sequenced) or data.events == cjson.null or data.events == nil
        if not wants then
            for _, event in ipairs(data.events) do
                if event == ARGV[1] then wants = true break end
            end
        end
        if wants then
            local seq = 0
            if sequenced then
                -- next sequence number, and into the replay buffer (trimmed to its size)
                seq = redis.call("INCR", seqKey)
                if bufferSize > 0 then
                    local length = redis.call("RPUSH", bufferKey, payloadHead .. seq .. payloadTail)
                    if length > bufferSize then redis.call("LTRIM", bufferKey, -bufferSize, -1) end
                    -- a new buffer gets the TTL of its session
                    if length == 1 then
                        local ttl = redis.call("PTTL", session)
                        if ttl > 0 then redis.call("PEXPIRE", bufferKey, ttl) end
                    end
                end
            end
            local connectionId = data.connectionId
            if connectionId == cjson.null or connectionId == nil then connectionId = "" end
            table.insert(results, sessionId)
            table.insert(results, connectionId)
            table.insert(results, seq)
        end
    end
end
return results
`;

// Sets connectionId to null and the resume TTL – only if the session still belongs to that connection.
const detach: string = `
local raw = redis.call("GET", KEYS[1])
if not raw or cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
local from, to = string.find(raw, '"connectionId":"' .. ARGV[1] .. '"', 1, true)
if not from then return 0 end
redis.call("SET", KEYS[1], string.sub(raw, 1, from - 1) .. '"connectionId":null' .. string.sub(raw, to + 1), "PX", ARGV[2])
redis.call("PEXPIRE", KEYS[2], ARGV[2])
redis.call("PEXPIRE", KEYS[3], ARGV[2])
return 1
`;

// Deletes a session – only if it still belongs to that connection (it may have been resumed elsewhere).
const destroyOwned: string = `
local raw = redis.call("GET", KEYS[1])
if not raw or cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
redis.call("SREM", KEYS[4], ARGV[2])
return 1
`;

/** The scripts by name, for SessionStore. */
export const SessionStoreScripts = {
    dispatch,
    detach,
    destroyOwned,
} as const;
