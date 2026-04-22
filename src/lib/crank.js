import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { logger } from "./logger.js";
import { playRound } from "../services/game.service.js";
import { env } from "../config/env.js";

// ── Distributed Lock ────────────────────────────────────────────────

const CRANK_LOCK_KEY = "crank:active_lock";
const CRANK_LOCK_TTL = 120; // seconds — max time a single crank cycle can hold the lock

/**
 * Acquire a distributed lock via Redis SET NX EX.
 * Prevents multiple workers from cranking the same match simultaneously.
 */
async function acquireLock(matchId) {
  const key = `${CRANK_LOCK_KEY}:${matchId}`;
  const result = await redis.set(key, Date.now(), "EX", CRANK_LOCK_TTL, "NX");
  return result === "OK";
}

async function releaseLock(matchId) {
  const key = `${CRANK_LOCK_KEY}:${matchId}`;
  await redis.del(key);
}

// ── Crank Engine ────────────────────────────────────────────────────

let isRunning = false;
let intervalHandle = null;

/**
 * Start the crank engine. Runs a polling loop that:
 *  1. Finds active matches
 *  2. Acquires a distributed lock per match
 *  3. Advances each match by one round
 *  4. Releases the lock
 *
 * The crank only runs on a single worker to avoid duplicate operations.
 */
export function startCrankEngine() {
  if (!env.CRANK_ENABLED) {
    logger.info("Crank engine DISABLED (CRANK_ENABLED=false)");
    return;
  }

  if (isRunning) {
    logger.warn("Crank engine already running, skipping duplicate start");
    return;
  }

  isRunning = true;
  const intervalMs = env.CRANK_INTERVAL_MS;

  logger.info("Crank engine STARTED", { intervalMs });

  intervalHandle = setInterval(async () => {
    try {
      await crankCycle();
    } catch (error) {
      logger.error("Crank cycle error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error?.stack,
      });
    }
  }, intervalMs);
}

/**
 * Stop the crank engine gracefully.
 */
export function stopCrankEngine() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isRunning = false;
  logger.info("Crank engine STOPPED");
}

/**
 * A single crank cycle: find active matches and advance each by one round.
 */
async function crankCycle() {
  // Find all ACTIVE matches (PENDING matches must be activated via API first)
  const activeMatches = await prisma.match.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    take: 5, // Process at most 5 matches per cycle
  });

  if (activeMatches.length === 0) {
    return; // Nothing to crank
  }

  for (const match of activeMatches) {
    const locked = await acquireLock(match.id);

    if (!locked) {
      logger.info("Match already being cranked, skipping", {
        matchId: match.id,
      });
      continue;
    }

    try {
      logger.info("Cranking match", {
        matchId: match.id,
        gameId: match.gameId,
        round: match.roundNumber,
      });

      const result = await playRound(match.id);

      if (result.match.status === "RESOLVED") {
        logger.info("Match resolved by crank", {
          matchId: match.id,
          gameId: match.gameId,
        });
      }
    } catch (error) {
      logger.error("Crank failed for match", {
        matchId: match.id,
        gameId: match.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await releaseLock(match.id);
    }
  }
}
