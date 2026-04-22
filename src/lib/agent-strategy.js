import { logger } from "../lib/logger.js";

/**
 * AI Agent Strategy Module
 *
 * Implements a simplified but strategically sound blackjack decision
 * engine. Each agent evaluates its hand independently and decides
 * whether to HIT or STAY based on probability-weighted heuristics.
 *
 * The strategy accounts for:
 *   - Current hand score vs. 21
 *   - Bust risk on the next card (simplified infinite-deck probabilities)
 *   - Opponent's visible score (if available)
 *   - Game HP context (conservative when healthy, aggressive when behind)
 */

// ── Card Distribution (Infinite Deck) ───────────────────────────────
//
// Cards 2-9: each has 1/13 probability  ≈ 7.69%
// Card 10 (10, J, Q, K): 4/13           ≈ 30.77%
// Card Ace (1 or 11): 1/13              ≈ 7.69%

const CARD_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10];
const TOTAL_CARDS = CARD_VALUES.length; // 13

/**
 * Calculate the probability of going bust when drawing one more card.
 *
 * @param {number} currentScore - The player's current score
 * @returns {number} Bust probability between 0 and 1
 */
function bustProbability(currentScore) {
  if (currentScore >= 21) return 1.0;

  const maxSafeCard = 21 - currentScore;
  let bustCards = 0;

  for (const value of CARD_VALUES) {
    // Ace can be 1 if it would bust as 11 — handled by smart aces on-chain.
    // For strategy purposes, we treat the next ace as min(11, maxSafe+1)
    // to evaluate worst-case bust risk.
    if (value > maxSafeCard) {
      bustCards++;
    }
  }

  return bustCards / TOTAL_CARDS;
}

/**
 * Calculate the expected value improvement of one more card.
 *
 * @param {number} currentScore - The player's current score
 * @returns {number} Expected score after a hit (approximate)
 */
function expectedScoreAfterHit(currentScore) {
  let sum = 0;
  let count = 0;

  for (const value of CARD_VALUES) {
    const newScore = currentScore + value;
    // If the ace (value=1 case) was already counted via on-chain smart aces,
    // ignore the 11-value treatment here. We model the minimum.
    sum += newScore;
    count++;
  }

  return sum / count;
}

/**
 * Compute how "close to 21" a score is, using absolute distance.
 *
 * @param {number} score - Player's score
 * @returns {number} Absolute distance from 21
 */
function distanceFrom21(score) {
  return Math.abs(21 - score);
}

// ── Strategy Profiles ───────────────────────────────────────────────

/**
 * Conservative strategy — stays earlier, avoids risk.
 * Used when the agent has a significant HP lead.
 */
function conservativeThreshold() {
  return 17;
}

/**
 * Balanced strategy — standard blackjack strategy.
 * Used in neutral HP situations.
 */
function balancedThreshold() {
  return 15;
}

/**
 * Aggressive strategy — takes more risks.
 * Used when behind on HP and needs to win rounds.
 */
function aggressiveThreshold() {
  return 13;
}

/**
 * Select the stay threshold based on HP differential.
 *
 * @param {number} myHp - This agent's current HP
 * @param {number} opponentHp - Opponent's current HP
 * @returns {number} The minimum score at which the agent will stay
 */
function selectStayThreshold(myHp, opponentHp) {
  const hpDiff = myHp - opponentHp;

  if (hpDiff >= 4) return conservativeThreshold(); // Comfortable lead
  if (hpDiff <= -4) return aggressiveThreshold(); // Desperately behind
  return balancedThreshold(); // Neutral
}

// ── Main Decision Function ──────────────────────────────────────────

/**
 * Decide whether an AI agent should HIT or STAY.
 *
 * @param {Object} params
 * @param {number} params.myScore - The agent's current blackjack score
 * @param {number} params.opponentScore - Opponent's visible score
 * @param {number} params.myHp - Agent's remaining HP
 * @param {number} params.opponentHp - Opponent's remaining HP
 * @param {number} params.roundNumber - Current round (affects damage scaling)
 * @param {string} params.player - "RED" or "BLUE"
 * @returns {"HIT" | "STAY"} The agent's decision
 */
export function decideAction({
  myScore,
  opponentScore,
  myHp,
  opponentHp,
  roundNumber,
  player,
}) {
  // Hard constraints: forced stay at 21+
  if (myScore >= 21) {
    logger.info("Agent forced to STAY (score >= 21)", { player, myScore });
    return "STAY";
  }

  const stayThreshold = selectStayThreshold(myHp, opponentHp);
  const bustProb = bustProbability(myScore);
  const myDist = distanceFrom21(myScore);
  const oppDist = distanceFrom21(opponentScore);

  // Situational overrides:

  // 1. If we're already closer to 21 than the opponent, be cautious
  if (myDist < oppDist && myScore >= stayThreshold) {
    logger.info("Agent STAY — already winning position", {
      player,
      myScore,
      opponentScore,
      myDist,
      oppDist,
    });
    return "STAY";
  }

  // 2. High bust probability (> 60%) — stay if score is reasonable
  if (bustProb > 0.6 && myScore >= stayThreshold) {
    logger.info("Agent STAY — high bust risk", {
      player,
      myScore,
      bustProb: bustProb.toFixed(2),
    });
    return "STAY";
  }

  // 3. Very high bust probability (> 80%) — stay unless desperately behind
  if (bustProb > 0.8) {
    const isDesperate = myHp <= 2 && opponentHp > myHp;
    if (!isDesperate) {
      logger.info("Agent STAY — extreme bust risk", {
        player,
        myScore,
        bustProb: bustProb.toFixed(2),
      });
      return "STAY";
    }
  }

  // 4. Below threshold — hit
  if (myScore < stayThreshold) {
    logger.info("Agent HIT — below threshold", {
      player,
      myScore,
      stayThreshold,
    });
    return "HIT";
  }

  // 5. Score is at or above threshold — evaluate opponent
  //    If opponent has a better hand, take a calculated risk
  if (oppDist < myDist && bustProb < 0.5) {
    logger.info("Agent HIT — opponent has better position, acceptable risk", {
      player,
      myScore,
      opponentScore,
      bustProb: bustProb.toFixed(2),
    });
    return "HIT";
  }

  // 6. Late rounds with high damage scaling — be more conservative
  if (roundNumber >= 3 && myScore >= 16) {
    logger.info("Agent STAY — late round, high damage risk", {
      player,
      myScore,
      roundNumber,
    });
    return "STAY";
  }

  // Default: stay if we've reached the threshold
  logger.info("Agent STAY — default", { player, myScore, stayThreshold });
  return "STAY";
}
