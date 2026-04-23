import { logger } from "../lib/logger.js";
import { callLlmAgent, buildAgentQuery } from "./llm-client.js";

/**
 * AI Agent Strategy Module — LLM-Powered
 *
 * Delegates hit/stay decisions to external LLMs via the LLM API.
 * Each agent is backed by a randomly chosen OpenRouter model
 * that persists for the duration of the match.
 *
 * Falls back to a basic heuristic strategy if the LLM call fails.
 */

// ── Main Decision Function ──────────────────────────────────────────

/**
 * Get an LLM-powered decision for whether the agent should HIT or STAY.
 *
 * @param {Object} params
 * @param {string} params.chatId - The match UUID for LLM conversation context
 * @param {string} params.model - The OpenRouter model identifier for this agent
 * @param {string} params.player - "RED" or "BLUE"
 * @param {number} params.myScore - The agent's current blackjack score
 * @param {number} params.opponentScore - Opponent's visible score
 * @param {number} params.myHp - Agent's remaining HP
 * @param {number} params.opponentHp - Opponent's remaining HP
 * @param {number} params.roundNumber - Current round (affects damage scaling)
 * @param {boolean} params.myStayed - Whether this agent has already stayed
 * @param {boolean} params.opponentStayed - Whether the opponent has stayed
 * @param {number} params.myAces - Number of aces in this agent's hand
 * @returns {Promise<"HIT" | "STAY">} The agent's decision
 */
export async function decideAction({
  chatId,
  model,
  player,
  myScore,
  opponentScore,
  myHp,
  opponentHp,
  roundNumber,
  myStayed,
  opponentStayed,
  myAces,
}) {
  // Hard constraint: forced stay at 21+
  if (myScore >= 21) {
    logger.info("Agent forced to STAY (score >= 21)", { player, myScore });
    return "STAY";
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
    });

    const result = await callLlmAgent({ chatId, model, query });
    return result.action;
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
 * Uses basic blackjack probability thresholds.
 */
function fallbackDecision({ myScore, opponentScore, myHp, opponentHp }) {
  if (myScore >= 21) return "STAY";

  // HP-aware threshold selection
  const hpDiff = myHp - opponentHp;
  let threshold = 15; // Balanced

  if (hpDiff >= 4) threshold = 17; // Conservative (healthy lead)
  if (hpDiff <= -4) threshold = 13; // Aggressive (behind)

  if (myScore < threshold) return "HIT";

  // If opponent is closer to 21 and bust risk is acceptable
  const myDist = Math.abs(21 - myScore);
  const oppDist = Math.abs(21 - opponentScore);
  const maxSafe = 21 - myScore;
  const bustProb =
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10].filter((v) => v > maxSafe)
      .length / 13;

  if (oppDist < myDist && bustProb < 0.5) return "HIT";

  return "STAY";
}
