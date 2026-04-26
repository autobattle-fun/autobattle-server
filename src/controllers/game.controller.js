import {
  startMatch,
  playRound,
  playUntilResolved,
  getMatchState,
  getActiveMatch,
  listMatches,
  pauseMatch,
  resumeMatch,
} from "../services/game.service.js";
import {
  validate,
  advanceMatchSchema,
  listMatchesSchema,
} from "../utils/validators.js";
import { getMatchBreakCountdown } from "../lib/game-state-store.js";

/**
 * POST /games/start
 * Start a new match (init game + create market on-chain + Prisma).
 * Agent wallets and LLM models are selected automatically.
 */
export async function startMatchController(request, response) {
  const result = await startMatch();

  return response.status(201).json({
    success: true,
    message: `Match #${result.match.gameId} created — ${result.match.llmRed} vs ${result.match.llmBlue}`,
    data: result,
  });
}

/**
 * POST /games/:matchId/advance
 * Advance a match by the specified number of rounds.
 */
export async function advanceMatchController(request, response) {
  const { matchId } = request.params;
  const { rounds } = validate(advanceMatchSchema, request.body || {});

  let result;
  if (rounds === 1) {
    result = await playRound(matchId);
  } else {
    result = await playUntilResolved(matchId, rounds);
  }

  return response.json({
    success: true,
    data: result,
  });
}

/**
 * GET /games
 * List matches with optional status filter and pagination.
 */
export async function listMatchesController(request, response) {
  const params = validate(listMatchesSchema, request.query || {});
  const result = await listMatches(params);

  return response.json({
    success: true,
    data: result,
  });
}

/**
 * GET /games/active
 * Get the currently active match (includes PAUSED matches).
 */
export async function activeMatchController(request, response) {
  const match = await getActiveMatch();

  if (!match) {
    return response.json({
      success: true,
      data: null,
      message: "No active match found.",
    });
  }

  return response.json({
    success: true,
    data: match,
  });
}

/**
 * GET /games/:matchId
 * Get detailed match state including live on-chain data.
 */
export async function getMatchController(request, response) {
  const { matchId } = request.params;
  const result = await getMatchState(matchId);

  return response.json({
    success: true,
    data: result,
  });
}

/**
 * POST /games/:matchId/pause
 * Manually pause an active match. Requires admin API key.
 */
export async function pauseMatchController(request, response) {
  const { matchId } = request.params;
  const reason = request.body?.reason || "Manual pause via API";
  const result = await pauseMatch(matchId, reason);

  return response.json({
    success: true,
    message: `Match #${result.gameId} paused.`,
    data: result,
  });
}

/**
 * POST /games/:matchId/resume
 * Resume a paused match. Requires admin API key.
 */
export async function resumeMatchController(request, response) {
  const { matchId } = request.params;
  const result = await resumeMatch(matchId);

  return response.json({
    success: true,
    message: `Match #${result.gameId} resumed.`,
    data: result,
  });
}

/**
 * GET /games/countdown
 * Get the current break countdown between matches.
 */
export async function countdownController(request, response) {
  const countdown = await getMatchBreakCountdown();

  return response.json({
    success: true,
    data: countdown,
  });
}
/**
 * GET /games/:gameId/stats
 * Get the live on-chain game stats.
 */
export async function getGameStatsController(request, response) {
  const gameId = Number(request.params.gameId);
  if (isNaN(gameId)) return response.status(400).json({ success: false, error: "Invalid gameId." });

  try {
    const { solanaService } = await import("../services/solana.service.js");
    const gs = await solanaService.fetchGameState(gameId);

    const currentPhase = Object.keys(gs.phase)[0];
    const activePlayer = Object.keys(gs.activePlayer)[0];
    const winner = gs.winner ? Object.keys(gs.winner)[0] : null;

    const stats = {
      gameId: gs.gameId.toNumber(),
      phase: currentPhase,
      roundNumber: gs.roundNumber,
      activePlayer: activePlayer.toUpperCase(),
      winner: winner ? winner.toUpperCase() : null,
      agents: { red: gs.agentRed.toBase58(), blue: gs.agentBlue.toBase58() },
      red: { hp: gs.p1Hp, score: gs.p1Score, aces: gs.p1Aces, hasStayed: gs.p1Stayed, lastCardDrawn: gs.p1LastCard },
      blue: { hp: gs.p2Hp, score: gs.p2Score, aces: gs.p2Aces, hasStayed: gs.p2Stayed, lastCardDrawn: gs.p2LastCard },
    };

    return response.status(200).json({ success: true, data: stats });
  } catch (error) {
    if (error.message.includes("Account does not exist")) {
      return response.status(404).json({ success: false, error: "Match not found on-chain." });
    }
    return response.status(500).json({ success: false, error: error.message });
  }
}
