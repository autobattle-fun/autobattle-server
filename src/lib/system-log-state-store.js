import { redis } from "../db/redis.js";
import { logger } from "./logger.js";

const KEY_PREFIX = "autobattle:system-log";

// helper method to get the redis key for the system logs
function getRoundLogsKey(matchId) {
    return `${KEY_PREFIX}:${matchId}:system-logs`;
}

// Add a system log entry for a specific round
export async function addRoundSystemLog(matchId, role, log) {
    const key = getRoundLogsKey(matchId);

    const entry = {
        role,
        log,
        timestamp: Date.now(),
    };

    // Append the log to the list for this round
    await redis.rpush(key, JSON.stringify(entry));
    await redis.expire(key, 86400);

    logger.info("Round system log added");
}

// Get all system logs for a specific round
export async function getRoundSystemLogs(matchId) {
    const key = getRoundLogsKey(matchId);

    const logs = await redis.lrange(key, 0, -1);

    // Parse JSON logs and return as array of objects
    return logs.map((log) => JSON.parse(log));
}

// Clear system logs for a specific round (useful after round resolution)
export async function clearRoundSystemLogs(matchId) {
    const key = getRoundLogsKey(matchId);
    await redis.del(key);

    logger.info("Round system logs cleared", { matchId });
}