import { logger } from "../lib/logger.js";
import { callLlmAgent, buildAgentQuery } from "./llm-client.js";

/**
 * AI Agent Strategy Module — LLM-Powered
 *
 * Delegates hit/stay decisions to external LLMs via the LLM API.
 * Each agent is backed by a randomly chosen OpenRouter model
 * that persists for the duration of the match.
 *
 * Returns { action, reason } — the reason is persisted in the DB.
 * Falls back to a basic heuristic strategy if the LLM call fails.
 */

// ── Main Decision Function ──────────────────────────────────────────

/**
 * Get an LLM-powered decision for whether the agent should HIT or STAY.
 *
 * @returns {Promise<{action: "HIT" | "STAY", reason: string}>}
 */
export async function decideAction({
  chatId,
  model,
  player,
  name,
  myScore,
  opponentScore,
  myHp,
  opponentHp,
  roundNumber,
  myStayed,
  opponentStayed,
  myAces,
  myCards,
  opponentCards,
  cardHistory,
}) {
  // Hard constraint: forced stay at 21+
  if (myScore >= 21) {
    logger.info("Agent forced to STAY (score >= 21)", { player, myScore });
    return { action: "STAY", reason: "Score is 21 or above — forced stay" };
  }

  try {
    const query = buildAgentQuery({
      player,
      myScore,
      opponentScore,
      myHp,
      opponentHp,
      roundNumber,
      myStayed,
      opponentStayed,
      myAces,
      myCards,
      opponentCards,
      cardHistory,
    });

    const result = await callLlmAgent({ chatId, model, query, name });
    return { action: result.action, reason: result.reason };
  } catch (error) {
    logger.error("LLM agent call failed, using fallback strategy", {
      player,
      model,
      error: error.message,
    });

    // Fallback: basic heuristic strategy
    return fallbackDecision({ myScore, opponentScore, myHp, opponentHp });
  }
}

// ── Fallback Heuristic ──────────────────────────────────────────────

/**
 * Simple fallback strategy used when the LLM API is unavailable.
 * Returns { action, reason }.
 */
function fallbackDecision({ myScore, opponentScore, myHp, opponentHp }) {
  if (myScore >= 21)
    return { action: "STAY", reason: "[Fallback] Score >= 21" };

  const hpDiff = myHp - opponentHp;
  let threshold = 15;
  let profile = "balanced";

  if (hpDiff >= 4) {
    threshold = 17;
    profile = "conservative";
  }
  if (hpDiff <= -4) {
    threshold = 13;
    profile = "aggressive";
  }

  if (myScore < threshold) {
    return {
      action: "HIT",
      reason: `[Fallback] Score ${myScore} < threshold ${threshold} (${profile})`,
    };
  }

  const myDist = Math.abs(21 - myScore);
  const oppDist = Math.abs(21 - opponentScore);
  const maxSafe = 21 - myScore;
  const bustProb =
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10].filter((v) => v > maxSafe)
      .length / 13;

  if (oppDist < myDist && bustProb < 0.5) {
    return {
      action: "HIT",
      reason: `[Fallback] Opponent closer to 21, bust risk ${Math.round(bustProb * 100)}% acceptable`,
    };
  }

  return {
    action: "STAY",
    reason: `[Fallback] Score ${myScore} >= threshold ${threshold}, bust risk ${Math.round(bustProb * 100)}%`,
  };
}
