import { jsonrepair } from "jsonrepair";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { getCelebrityByName } from "../services/celebrity.service.js";

// ── OpenRouter Model Pool ───────────────────────────────────────────
//
// A curated list of capable LLMs available on OpenRouter.
// One model is randomly selected per agent per match.

// const OPENROUTER_MODELS = Object.freeze([
//   "openai/gpt-4o",
//   "openai/gpt-4o-mini",
//   "anthropic/claude-3.5-sonnet",
//   "anthropic/claude-3-haiku",
//   "google/gemini-2.0-flash-001",
//   "google/gemini-2.5-flash-preview",
//   "meta-llama/llama-3.1-70b-instruct",
//   "meta-llama/llama-3.1-8b-instruct",
//   "mistralai/mistral-large",
//   "mistralai/mistral-small",
//   "deepseek/deepseek-chat-v3-0324",
//   "qwen/qwen-2.5-72b-instruct",
// ]);

// Free model for testing
const OPENROUTER_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash-lite"
]

/**
 * Select two distinct random models from the pool for a match.
 * Returns { redModel, blueModel }.
 */
export function selectMatchModels() {
  const shuffled = [...OPENROUTER_MODELS].sort(() => Math.random() - 0.5);
  return {
    redModel: shuffled[0],
    blueModel: shuffled[1],
  };
}

// ── System Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a competitive blackjack AI agent playing in a prediction market arena on Solana. You are battling another AI agent in a modified blackjack duel where spectators bet on the winner.

GAME RULES:
- Both players start with 10 HP.
- Each round, 1 card is dealt to each player face-up. Then each player can HIT (draw more cards) or STAY.
- Cards 2-10 are face value. Jack, Queen, King = 10. Ace = 11 (auto-downgrades to 1 if total exceeds 21).
- You can HIT (draw another card) or STAY (lock your hand).
- If your score reaches 21 or higher, you are forced to STAY.
- After both players lock in, a final "river card" is dealt to both simultaneously — this can flip everything.
- The player further from 21 (by absolute distance) takes damage. Damage doubles each round (Round 1 = 1 dmg, Round 2 = 2 dmg, Round 3 = 4 dmg...).
- Ties trigger sudden death: both get extra cards until someone is closer to 21.
- The match ends when a player reaches 0 HP.

STRATEGY CONSIDERATIONS:
- Low scores (under 14) almost always benefit from a HIT — the bust risk is low.
- Scores 15-17 are the critical decision zone — weigh bust probability against opponent's position.
- Scores 18-20 are strong hands — usually STAY unless desperate.
- Consider the opponent's visible score. If they're already closer to 21, you may need to risk a HIT.
- Consider HP differential: if you're ahead on HP, play conservatively; if behind, take risks.
- Remember: a final river card will be dealt AFTER you stay, adding to your score.
- Going over 21 is not instant death — you just need to be CLOSER to 21 than your opponent.

You MUST respond with ONLY a valid JSON object containing your action and your reasoning. No explanation outside the JSON, no markdown:
{"action": "HIT", "reason": "My score is 14 and opponent has 18. I need to get closer to 21."}
or
{"action": "STAY", "reason": "My score is 19, bust risk is too high at 69%. The river card is a gamble either way."}`;



// ── Query Builder ───────────────────────────────────────────────────

/**
 * Build the query string sent to the LLM with full match context,
 * including card history from previous rounds and current round.
 */
export function buildAgentQuery({
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
}) {
  const damageTier = Math.pow(2, roundNumber - 1);
  const myCardLabels =
    myCards?.length > 0
      ? myCards.map((c) => c.label).join(", ")
      : "None yet";
  const oppCardLabels =
    opponentCards?.length > 0
      ? opponentCards.map((c) => c.label).join(", ")
      : "None yet";

  let query = `

CURRENT MATCH STATE:
You are the ${player} agent.
Round: ${roundNumber} (Damage this round: ${damageTier} HP)

YOUR HAND:
- Cards: [${myCardLabels}]
- Score: ${myScore}
- Aces in hand: ${myAces}
- Status: ${myStayed ? "STAYED (locked)" : "ACTIVE — your turn to decide"}

OPPONENT'S HAND:
- Cards: [${oppCardLabels}]
- Score: ${opponentScore}
- Status: ${opponentStayed ? "STAYED (locked)" : "Still deciding"}

HP STATUS:
- Your HP: ${myHp}/10
- Opponent HP: ${opponentHp}/10

ANALYSIS:
- Distance from 21: You = ${Math.abs(21 - myScore)}, Opponent = ${Math.abs(21 - opponentScore)}
- ${myScore > opponentScore ? "You are currently AHEAD" : myScore < opponentScore ? "You are currently BEHIND" : "You are currently TIED"}
- Bust probability if you HIT: ~${getBustProbDescription(myScore)}`;

  if (cardHistory) {
    query += `\n\n${cardHistory}`;
  }

  query += `\n\nWhat is your decision? Respond with ONLY valid JSON: {"action": "HIT"|"STAY", "reason": "your reasoning"}`;
  return query;
}

function getBustProbDescription(score) {
  if (score >= 21) return "100% (forced stay)";
  const maxSafe = 21 - score;
  const bustCount = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10].filter(
    (v) => v > maxSafe,
  ).length;
  return `${Math.round((bustCount / 13) * 100)}%`;
}

// ── LLM API Client ──────────────────────────────────────────────────

/**
 * Call the LLM API to get an agent's decision.
 *
 * @param {Object} params
 * @param {string} params.chatId - The match UUID (used as conversation context)
 * @param {string} params.model - OpenRouter model identifier
 * @param {string} params.query - The full query text
 * @param {string} params.name - The assigned celebrity name
 * @returns {Promise<{action: "HIT" | "STAY", reason: string}>} Parsed decision
 */
export async function callLlmAgent({ chatId, model, query, name }) {
  // const endpoint = `${env.LLM_API_ENDPOINT}?chatId=${encodeURIComponent(chatId)}`;
  const endpoint = env.LLM_API_ENDPOINT;

  const celebrity = await getCelebrityByName(name);
  const behaviourPrompt = celebrity?.prompt || "You are a standard AI agent.";
  const systemPrompt = SYSTEM_PROMPT + "\n\nYOUR PERSONA:\n" + behaviourPrompt;

  logger.info("Calling LLM agent", { chatId, model, name });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, query, systemPrompt }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `LLM API returned ${response.status}: ${errorText.slice(0, 200)}`,
    );
  }

  const data = await response.json();

  // Extract the text output from the nested response structure:
  // data.executionLogs.result.outputs[0]["output_text-*"].Text
  const textOutput = extractLlmText(data);

  if (!textOutput) {
    logger.warn("LLM returned empty text, defaulting to STAY", {
      chatId,
      model,
    });
    return { action: "STAY", reason: "LLM returned empty response" };
  }

  // Parse JSON with repair
  try {
    const repaired = jsonrepair(textOutput);
    const parsed = JSON.parse(repaired);
    const action = parsed?.action?.toUpperCase?.();
    const reason = parsed?.reason || "No reason provided";

    if (action === "HIT" || action === "STAY") {
      logger.info("LLM decision", { chatId, model, action, reason });
      return { action, reason };
    }

    logger.warn("LLM returned invalid action, defaulting to STAY", {
      chatId,
      model,
      rawAction: parsed?.action,
    });
    return { action: "STAY", reason: `Invalid LLM action: ${parsed?.action}` };
  } catch (parseError) {
    logger.warn("LLM JSON parse failed, defaulting to STAY", {
      chatId,
      model,
      rawText: textOutput.slice(0, 200),
      error: parseError.message,
    });
    return { action: "STAY", reason: "Failed to parse LLM response" };
  }
}

/**
 * Extract the text output from the LLM API response.
 * Handles the nested structure:
 *   data.executionLogs.result.outputs[0]["output_text-*"].Text
 */
function extractLlmText(data) {
  try {
    const outputs = data?.executionLogs?.result?.outputs;

    if (!Array.isArray(outputs) || outputs.length === 0) {
      return null;
    }

    // The first output object has a dynamic key like "output_text-1776951832553"
    const firstOutput = outputs[0];
    const outputKey = Object.keys(firstOutput).find((k) =>
      k.startsWith("output_text"),
    );

    if (!outputKey) return null;
    return firstOutput[outputKey]?.Text || null;
  } catch {
    return null;
  }
}
