import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { logger } from "./logger.js";
import { playRound, startMatch } from "../services/game.service.js";
import { env } from "../config/env.js";
import { getMatchBreakCountdown, clearMatchBreakCountdown } from "./game-state-store.js";

// ── Distributed Lock ────────────────────────────────────────────────

const CRANK_LOCK_KEY = "autobattle:crank:active_lock";
const CRANK_LOCK_TTL = 600; // seconds — max time a single crank cycle can hold the lock

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
 *  1. Checks if a new match should auto-start (after break)
 *  2. Finds active matches (skips PAUSED)
 *  3. Acquires a distributed lock per match
 *  4. Advances each match by one round
 *  5. Releases the lock
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

  // Use recursive setTimeout instead of setInterval to guarantee
  // the next cycle only starts after the previous one completes.
  // setInterval can overlap when crankCycle takes longer than intervalMs.
  async function scheduleNext() {
    if (!isRunning) return;
    try {
      await crankCycle();
    } catch (error) {
      logger.error("Crank cycle error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error?.stack,
      });
    }
    if (isRunning) {
      intervalHandle = setTimeout(scheduleNext, intervalMs);
    }
  }

  intervalHandle = setTimeout(scheduleNext, intervalMs);
}

/**
 * Stop the crank engine gracefully.
 */
export function stopCrankEngine() {
  isRunning = false;
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
  }
  logger.info("Crank engine STOPPED");
}

/**
 * A single crank cycle:
 *  1. Check if break has expired → auto-start a new match
 *  2. Find active matches and advance each by one round
 *  3. Skip PAUSED matches
 */
async function crankCycle() {
  // ── Phase 1: Auto-start new match after break ─────────────────
  await maybeAutoStartMatch();

  // ── Phase 2: Advance active matches ───────────────────────────
  // Find all ACTIVE matches (PENDING matches must be activated via API first)
  // PAUSED matches are explicitly skipped
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
      // Note: If the error was a transaction failure, withRetry in game.service
      // will have already paused the match and sent notifications.
    } finally {
      await releaseLock(match.id);
    }
  }
}

/**
 * Check if the break between matches has expired, and auto-start a new match if so.
 *
 * Break flow after a match resolves:
 *  1. MATCHMAKING countdown (3 min) — no match exists, pure wait
 *  2. MATCHMAKING expires → startMatch() creates match (MATCHMAKING status) + PREPARING countdown (2 min)
 *  3. PREPARING expires → transition match to ACTIVE
 */
async function maybeAutoStartMatch() {
  try {
    // Check if there are any active, matchmaking, or paused matches
    const existingMatch = await prisma.match.findFirst({
      where: { status: { in: ["ACTIVE", "MATCHMAKING", "PAUSED"] } },
    });

    if (existingMatch) {
      if (existingMatch.status === "MATCHMAKING") {
        // Match exists in MATCHMAKING status — waiting for PREPARING countdown to expire
        const countdown = await getMatchBreakCountdown();
        if (countdown.isBreak && countdown.phase === "PREPARING") {
          // Still in preparation phase — wait
          return;
        } else {
          // Preparing expired → switch to ACTIVE
          await prisma.match.update({ where: { id: existingMatch.id }, data: { status: "ACTIVE" } });
          logger.info("Preparing phase expired — Match is now ACTIVE", { matchId: existingMatch.id });
          await clearMatchBreakCountdown();
        }
      }
      return;
    }

    // No active match — check the break countdown
    const countdown = await getMatchBreakCountdown();

    if (countdown.isBreak) {
      // Still in MATCHMAKING break period — wait
      return;
    }

    // No active match, no break → start a new match
    logger.info("Matchmaking phase expired — auto-starting new match (entering PREPARING)");
    await clearMatchBreakCountdown();
    await startMatch();
  } catch (error) {
    logger.error("Auto-start match failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
