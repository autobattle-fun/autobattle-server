import { prisma } from "../db/prisma.js";
import { logger } from "./logger.js";
import { broadcast } from "./websocket.js";
import { notifyError } from "./telegram.js";

// ── Transaction Retry Wrapper ───────────────────────────────────────
//
// Wraps any async function (typically a Solana transaction) with retry
// logic. On final failure, the match is paused and devs are notified.

const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s

/**
 * Execute an async function with retry logic and automatic pause on failure.
 *
 * @param {Function} fn - The async function to execute
 * @param {Object} options
 * @param {string} options.label - Human-readable description of the operation
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts
 * @param {string} [options.matchId] - Prisma match ID (for pausing on failure)
 * @param {number} [options.gameId] - On-chain game ID (for logging)
 * @returns {*} The result of the function
 * @throws {Error} Re-throws the final error after pausing the match
 */
export async function withRetry(fn, { label, maxRetries = DEFAULT_MAX_RETRIES, matchId, gameId } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      logger.warn(`Transaction failed (attempt ${attempt}/${maxRetries})`, {
        label,
        matchId,
        gameId,
        error: error.message,
      });

      if (attempt < maxRetries) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying in ${backoffMs}ms...`, { label, attempt });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  // All retries exhausted — pause the match
  logger.error(`Transaction failed after ${maxRetries} retries — PAUSING MATCH`, {
    label,
    matchId,
    gameId,
    error: lastError.message,
  });

  if (matchId) {
    await pauseMatchOnError(matchId, label, lastError);
  }

  throw lastError;
}

/**
 * Pause a match due to a critical transaction failure.
 * Emits a WS event and sends a Telegram notification.
 */
async function pauseMatchOnError(matchId, label, error) {
  try {
    // Update match status to PAUSED
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "PAUSED" },
    });

    // Emit WebSocket event
    broadcast("game:paused", {
      matchId,
      reason: `Transaction failed after retries: ${label}`,
      error: error.message,
    }, matchId);

    // Emit error event via WebSocket
    broadcast("game:error", {
      matchId,
      label,
      error: error.message,
      severity: "CRITICAL",
    }, matchId);

    // Send Telegram notification
    await notifyError(`[${label}] Match ${matchId}`, error);

    logger.info("Match paused due to critical error", { matchId, label });
  } catch (pauseError) {
    // Don't let the pause mechanism itself crash the system
    logger.error("Failed to pause match after error", {
      matchId,
      originalError: error.message,
      pauseError: pauseError.message,
    });
  }
}
