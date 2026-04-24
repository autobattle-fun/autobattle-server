import { redis } from "../db/redis.js";
import { logger } from "./logger.js";

/**
 * Redis-backed Game State Store
 *
 * Stores ephemeral per-match game state that is too granular for
 * Prisma (e.g. individual cards dealt per round). This data is
 * consumed during the round loop and then persisted to Prisma
 * as a MatchRound record once the round completes.
 *
 * Redis key pattern: `game:{gameId}:state`
 *
 * The stored object shape:
 * {
 *   gameId: number,
 *   matchId: string,
 *   matchUuid: string,
 *   roundNumber: number,
 *   phase: string,
 *   red: { score: number, hp: number, aces: number, stayed: boolean, cards: Card[] },
 *   blue: { score: number, hp: number, aces: number, stayed: boolean, cards: Card[] },
 *   riverRed: Card | null,
 *   riverBlue: Card | null,
 *   tiebreakerCards: { red: Card, blue: Card }[],
 *   pastRounds: RoundSummary[],
 *   moves: MoveRecord[],
 *   moveCounter: number,
 * }
 *
 * Card = { value: number, label: string }
 */

const KEY_PREFIX = "game";
const STATE_TTL = 86400; // 24h — auto-cleanup for abandoned matches

function stateKey(gameId) {
  return `${KEY_PREFIX}:${gameId}:state`;
}

// ── Card Inference ──────────────────────────────────────────────────

/**
 * Infer which card was dealt by comparing score changes and ace count.
 * Since the on-chain contract uses an infinite deck with smart aces,
 * we compute: newCard = newScore - oldScore (adjusted for ace downgrades).
 */
export function inferCard(oldScore, newScore, oldAces, newAces) {
  let value;
  const aceAdded = newAces > oldAces;

  if (aceAdded) {
    // An ace was added. It could be 11 or 1 (if it triggered a downgrade).
    // If score went up by 11, it's an ace counted as 11.
    // If score went up by 1, it's an ace counted as 1 (was already over 21).
    const diff = newScore - oldScore;
    value = diff > 0 ? diff : 1;
    return { value, label: "A" };
  }

  // For non-ace cards, score diff = card value.
  // But if an existing ace was downgraded (11→1), diff = cardValue - 10.
  // We detect this if oldAces > 0 and newAces < oldAces:
  if (newAces < oldAces) {
    // Ace downgrade happened. Real card = diff + 10
    value = newScore - oldScore + 10;
  } else {
    value = newScore - oldScore;
  }

  // Handle edge case where score didn't change (shouldn't happen in normal flow)
  if (value <= 0) value = 0;

  const label = cardLabel(value);
  return { value, label };
}

function cardLabel(value) {
  if (value === 1) return "A";
  if (value === 11) return "A";
  if (value === 10) {
    // Could be 10, J, Q, K — we can't distinguish, default to "10"
    return "10";
  }
  return String(value);
}

// ── State Operations ────────────────────────────────────────────────

/**
 * Initialize game state in Redis for a new match.
 */
export async function initGameState({ gameId, matchId, matchUuid }) {
  const state = {
    gameId,
    matchId,
    matchUuid,
    roundNumber: 1,
    phase: "PENDING",
    red: { score: 0, hp: 10, aces: 0, stayed: false, cards: [] },
    blue: { score: 0, hp: 10, aces: 0, stayed: false, cards: [] },
    riverRed: null,
    riverBlue: null,
    tiebreakerCards: [],
    pastRounds: [],
    moves: [],
    moveCounter: 0,
  };

  await redis.setex(stateKey(gameId), STATE_TTL, JSON.stringify(state));
  logger.info("Game state initialized in Redis", { gameId });
  return state;
}

/**
 * Get the current game state from Redis.
 */
export async function getGameState(gameId) {
  const raw = await redis.get(stateKey(gameId));
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * Update the game state in Redis (full replace).
 */
export async function setGameState(gameId, state) {
  await redis.setex(stateKey(gameId), STATE_TTL, JSON.stringify(state));
}

/**
 * Update specific fields in the game state.
 */
export async function updateGameState(gameId, updates) {
  const state = await getGameState(gameId);
  if (!state) {
    throw new Error(`No game state in Redis for gameId=${gameId}`);
  }
  const updated = { ...state, ...updates };
  await setGameState(gameId, updated);
  return updated;
}

/**
 * Record a card dealt to a player during the round.
 * Updates the player's cards array in Redis state.
 */
export async function recordCardDealt(gameId, player, card) {
  const state = await getGameState(gameId);
  if (!state) return;

  const side = player === "RED" ? "red" : "blue";
  state[side].cards.push(card);
  await setGameState(gameId, state);
}

/**
 * Record river cards.
 */
export async function recordRiverCards(gameId, redCard, blueCard) {
  const state = await getGameState(gameId);
  if (!state) return;

  state.riverRed = redCard;
  state.riverBlue = blueCard;
  await setGameState(gameId, state);
}

/**
 * Record a tiebreaker card pair.
 */
export async function recordTiebreakerCards(gameId, redCard, blueCard) {
  const state = await getGameState(gameId);
  if (!state) return;

  state.tiebreakerCards.push({ red: redCard, blue: blueCard });
  await setGameState(gameId, state);
}

/**
 * Record an agent move (action + reason).
 */
export async function recordMove(gameId, move) {
  const state = await getGameState(gameId);
  if (!state) return;

  state.moveCounter++;
  state.moves.push({ ...move, moveNumber: state.moveCounter });
  await setGameState(gameId, state);
  return state.moveCounter;
}

/**
 * Sync on-chain state into Redis (scores, hp, aces, stayed, phase).
 */
export async function syncOnChainState(gameId, onChainState, phase) {
  const state = await getGameState(gameId);
  if (!state) return;

  state.red.score = onChainState.p1Score;
  state.red.hp = onChainState.p1Hp;
  state.red.aces = onChainState.p1Aces;
  state.red.stayed = onChainState.p1Stayed;

  state.blue.score = onChainState.p2Score;
  state.blue.hp = onChainState.p2Hp;
  state.blue.aces = onChainState.p2Aces;
  state.blue.stayed = onChainState.p2Stayed;

  state.phase = phase;
  state.roundNumber = onChainState.roundNumber;

  await setGameState(gameId, state);
  return state;
}

/**
 * Archive current round data into pastRounds and reset for next round.
 */
export async function archiveRound(gameId, roundSummary) {
  const state = await getGameState(gameId);
  if (!state) return;

  state.pastRounds.push(roundSummary);

  // Reset for next round
  state.red.cards = [];
  state.blue.cards = [];
  state.red.stayed = false;
  state.blue.stayed = false;
  state.riverRed = null;
  state.riverBlue = null;
  state.tiebreakerCards = [];
  state.moves = [];
  state.moveCounter = 0;

  await setGameState(gameId, state);
  return state;
}

/**
 * Delete game state from Redis (after match ends).
 */
export async function deleteGameState(gameId) {
  await redis.del(stateKey(gameId));
  logger.info("Game state deleted from Redis", { gameId });
}

/**
 * Build a formatted card history string for LLM queries.
 */
export function formatCardHistory(state) {
  const lines = [];

  if (state.pastRounds.length > 0) {
    lines.push("PREVIOUS ROUNDS:");
    for (const round of state.pastRounds) {
      const redCards = round.redCards.map((c) => c.label).join(", ");
      const blueCards = round.blueCards.map((c) => c.label).join(", ");
      lines.push(
        `  Round ${round.roundNumber}: Red [${redCards}] → ${round.redScoreFinal} | Blue [${blueCards}] → ${round.blueScoreFinal} → Winner: ${round.winner || "TIE"}`,
      );
    }
    lines.push("");
  }

  if (state.red.cards.length > 0 || state.blue.cards.length > 0) {
    lines.push("CURRENT ROUND CARDS:");
    if (state.red.cards.length > 0) {
      const redLabels = state.red.cards.map((c) => c.label).join(", ");
      lines.push(`  Red cards: [${redLabels}]`);
    }
    if (state.blue.cards.length > 0) {
      const blueLabels = state.blue.cards.map((c) => c.label).join(", ");
      lines.push(`  Blue cards: [${blueLabels}]`);
    }
  }

  return lines.join("\n");
}

// ── Match Break Countdown ───────────────────────────────────────────

const BREAK_KEY = "match:next_start_at";

/**
 * Set a countdown for the next match start (stored as Unix timestamp in Redis).
 * @param {number} nextStartAtUnix - Unix timestamp (seconds) when the next match should start
 */
export async function setMatchBreakCountdown(nextStartAtUnix) {
  const ttl = Math.max(nextStartAtUnix - Math.floor(Date.now() / 1000), 1);
  await redis.setex(BREAK_KEY, ttl + 60, String(nextStartAtUnix)); // +60s buffer for reading after expiry
  logger.info("Match break countdown set", { nextStartAt: new Date(nextStartAtUnix * 1000).toISOString(), ttlSeconds: ttl });
}

/**
 * Get the current match break countdown status.
 * @returns {{ isBreak: boolean, remainingSeconds: number, nextStartAt: string | null }}
 */
export async function getMatchBreakCountdown() {
  const raw = await redis.get(BREAK_KEY);
  if (!raw) {
    return { isBreak: false, remainingSeconds: 0, nextStartAt: null };
  }

  const nextStartAtUnix = parseInt(raw, 10);
  const nowUnix = Math.floor(Date.now() / 1000);
  const remaining = nextStartAtUnix - nowUnix;

  if (remaining <= 0) {
    return { isBreak: false, remainingSeconds: 0, nextStartAt: null };
  }

  return {
    isBreak: true,
    remainingSeconds: remaining,
    nextStartAt: new Date(nextStartAtUnix * 1000).toISOString(),
  };
}

/**
 * Clear the match break countdown (e.g. when a new match starts).
 */
export async function clearMatchBreakCountdown() {
  await redis.del(BREAK_KEY);
  logger.info("Match break countdown cleared");
}
