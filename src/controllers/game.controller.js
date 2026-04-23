import {
  startMatch,
  playRound,
  playUntilResolved,
  getMatchState,
  getActiveMatch,
  listMatches,
} from "../services/game.service.js";
import {
  validate,
  advanceMatchSchema,
  listMatchesSchema,
} from "../utils/validators.js";

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
 * Get the currently active match.
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
