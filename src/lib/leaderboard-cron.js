import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { logger } from "./logger.js";

const LIVE_KEY = "leaderboard:live";
const LAST_WEEK_KEY = "leaderboard:last_week";
const META_KEY = "leaderboard:meta";
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let isRunning = false;
let intervalHandle = null;

export function startLeaderboardCron() {
  if (isRunning) {
    logger.warn("Leaderboard cron already running, skipping duplicate start");
    return;
  }

  isRunning = true;
  logger.info("Leaderboard cron STARTED", { intervalMs: INTERVAL_MS });

  // Run immediately on start, then schedule
  runCycle();

  async function scheduleNext() {
    if (!isRunning) return;
    await runCycle();
    if (isRunning) {
      intervalHandle = setTimeout(scheduleNext, INTERVAL_MS);
    }
  }

  intervalHandle = setTimeout(scheduleNext, INTERVAL_MS);
}

export function stopLeaderboardCron() {
  isRunning = false;
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
  }
  logger.info("Leaderboard cron STOPPED");
}

/**
 * Returns the Monday 00:00:00 UTC of the week containing the given date.
 */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function runCycle() {
  try {
    const now = new Date();
    const currentWeekStart = getWeekStart(now);
    const currentWeekKey = currentWeekStart.toISOString();

    // Check if we've rolled into a new week
    const lastWeekKey = await redis.hget(META_KEY, "currentWeekStart");

    if (lastWeekKey && lastWeekKey !== currentWeekKey) {
      // Week rolled over — snapshot the current live board as "last week"
      const liveData = await redis.get(LIVE_KEY);
      if (liveData) {
        await redis.set(LAST_WEEK_KEY, liveData);
        logger.info("Leaderboard: archived last week's leaderboard");
      }
    }

    // Update meta with current week
    await redis.hset(META_KEY, "currentWeekStart", currentWeekKey);
    await redis.hset(META_KEY, "lastUpdated", now.toISOString());

    // Compute current week's leaderboard from TradeLog
    const weekEnd = new Date(now);

    const topTraders = await prisma.tradeLog.groupBy({
      by: ["userId"],
      where: {
        createdAt: {
          gte: currentWeekStart,
          lte: weekEnd,
        },
      },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    });

    // Fetch user details for the top traders
    const userIds = topTraders.map((t) => t.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true },
    });

    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const leaderboard = topTraders.map((entry, index) => ({
      rank: index + 1,
      userId: entry.userId,
      username: userMap[entry.userId]?.username || "Unknown",
      tradeCount: entry._count.id,
    }));

    const payload = {
      weekStart: currentWeekStart.toISOString(),
      updatedAt: now.toISOString(),
      entries: leaderboard,
    };

    await redis.set(LIVE_KEY, JSON.stringify(payload));

    logger.info("Leaderboard: live board updated", {
      entries: leaderboard.length,
      weekStart: currentWeekKey,
    });
  } catch (error) {
    logger.error("Leaderboard cron cycle error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
