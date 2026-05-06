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
import { redis } from "../db/redis.js";
import { logger } from "../lib/logger.js";

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
  if (isNaN(gameId))
    return response
      .status(400)
      .json({ success: false, error: "Invalid gameId." });

  try {
    const { solanaService } = await import("../services/solana.service.js");
    const { getGameState, formatCardHistory } =
      await import("../lib/game-state-store.js");
    const { prisma } = await import("../db/prisma.js");
    const { parseColor } = await import("../utils/solana.helpers.js");

    const gs = await solanaService.fetchGameState(gameId);
    const match = await prisma.match.findUnique({ where: { gameId } });
    const redisState = await getGameState(gameId);

    const activePlayerColor = parseColor(gs.activePlayer);
    const activePlayerName =
      activePlayerColor === "RED" ? match?.redName : match?.blueName;

    let gameStatus = match?.status || "MATCHMAKING";
    if (gameStatus === "PAUSED") gameStatus = "ACTIVE";

    const stats = {
      gameId: gs.gameId.toNumber(),
      gameStatus,
      serverStatus: match?.status === "PAUSED" ? "PAUSED" : "ACTIVE",
      activePlayer: { color: activePlayerColor, name: activePlayerName },
      playerStatus: redisState?.playerStatus || {
        red: "WAITING",
        blue: "WAITING",
      },
      roundNumber: gs.roundNumber,
      winner: gs.winner ? parseColor(gs.winner) : null,
      red: {
        hp: gs.p1Hp,
        score: gs.p1Score,
        aces: gs.p1Aces,
        stayed: gs.p1Stayed,
        name: match?.redName,
        llm: match?.llmRed,
        cards: redisState?.red?.cards || [],
      },
      blue: {
        hp: gs.p2Hp,
        score: gs.p2Score,
        aces: gs.p2Aces,
        stayed: gs.p2Stayed,
        name: match?.blueName,
        llm: match?.llmBlue,
        cards: redisState?.blue?.cards || [],
      },
      river: { red: redisState?.riverRed, blue: redisState?.riverBlue },
      tiebreakerCards: redisState?.tiebreakerCards || [],
      cardHistory: {
        pastRounds: redisState?.pastRounds || [],
        currentRound: {
          redCards: redisState?.red?.cards || [],
          blueCards: redisState?.blue?.cards || [],
        },
      },
    };

    return response.status(200).json({ success: true, data: stats });
  } catch (error) {
    if (error.message.includes("Account does not exist")) {
      return response
        .status(404)
        .json({ success: false, error: "Match not found on-chain." });
    }
    return response.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /games/search/:gameId
 * Search for a match by its on-chain gameId.
 */
export async function searchByGameIdController(request, response) {
  const { gameId } = request.params;
  const id = parseInt(gameId);
  if (isNaN(id))
    return response
      .status(400)
      .json({ success: false, error: "Invalid gameId." });

  const cacheKey = `game:search:id:${id}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return response.json(JSON.parse(cached));
  } catch (err) {
    logger.warn("Redis game search cache read error", {
      gameId: id,
      error: err.message,
    });
  }

  const { prisma } = await import("../db/prisma.js");
  const match = await prisma.match.findUnique({
    where: { gameId: id },
  });

  if (!match) {
    return response
      .status(404)
      .json({ success: false, error: "Match not found." });
  }

  const result = await getMatchState(match.id);
  const responseData = {
    success: true,
    data: result,
  };

  try {
    // Cache for 5s if active, 1h if resolved (matching getMatchState logic)
    const ttl = result.match.status === "RESOLVED" ? 3600 : 5;
    await redis.setex(cacheKey, ttl, JSON.stringify(responseData));
  } catch (err) {
    logger.warn("Redis game search cache write error", {
      gameId: id,
      error: err.message,
    });
  }

  return response.json(responseData);
}
