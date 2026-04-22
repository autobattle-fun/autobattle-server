import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { solanaService, ROLL_TYPE } from "./solana.service.js";
import { decideAction } from "../lib/agent-strategy.js";
import {
  deriveGamePda,
  deriveMarketPda,
  deriveVaultPda,
  parseGamePhase,
  parseColor,
} from "../utils/solana.helpers.js";

// ── Match Lifecycle ─────────────────────────────────────────────────

/**
 * Start a brand new match:
 *  1. Fetch next game ID from on-chain registry
 *  2. Init game on-chain
 *  3. Create on-chain prediction market
 *  4. Persist Match + Market records in Prisma
 */
export async function startMatch({ agentRed, agentBlue } = {}) {
  const crank = solanaService.crankKeypair.publicKey;

  // Default agents to crank wallet (as per test.controller.js pattern)
  const redAgent = agentRed || crank.toBase58();
  const blueAgent = agentBlue || crank.toBase58();

  // 1. Get next game ID
  const gameId = await solanaService.getNextGameId();

  // 2. Derive PDAs
  const [gamePda] = deriveGamePda(gameId);
  const [marketPda] = deriveMarketPda(gameId, 0);
  const [vaultPda] = deriveVaultPda(gameId, 0);

  logger.info("Starting match", { gameId, redAgent, blueAgent });

  // 3. Init game on-chain
  await solanaService.initGame(gameId, redAgent, blueAgent);

  // 4. Create market on-chain (100 year expiry — permanent polymarket mode)
  const closesAtUnix = Math.floor(Date.now() / 1000) + 3_153_600_000;
  const question = `Will Red Win Match #${gameId}?`;
  await solanaService.createOnChainMarket(gameId, 0, question, closesAtUnix);

  // 5. Persist to database
  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        gameId,
        gamePda: gamePda.toBase58(),
        agentRed: redAgent,
        agentBlue: blueAgent,
        status: "PENDING",
      },
    });

    const market = await tx.market.create({
      data: {
        slug: `match-${gameId}-main`,
        title: `Match #${gameId}: Red vs Blue`,
        description: "Main prediction market for the overall match winner.",
        matchId: match.id,
        marketPda: marketPda.toBase58(),
        vaultPda: vaultPda.toBase58(),
        marketIndex: 0,
        marketType: "MAIN",
        status: "OPEN",
        closesAt: new Date(closesAtUnix * 1000),
      },
    });

    return { match, market };
  });

  logger.info("Match started", { matchId: result.match.id, gameId });
  return result;
}

// ── Round Orchestration ─────────────────────────────────────────────

/**
 * Play a single round for a match. This drives the complete round loop:
 *  1. Initial deal (VRF type 0)
 *  2. Agent decisions (strategic hits/stays)
 *  3. River card (VRF type 2)
 *  4. Resolve round
 *  5. Handle tiebreaker if needed
 *  6. Sync state to Prisma
 *
 * Returns the updated game state.
 */
export async function playRound(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { markets: { where: { marketIndex: 0 } } },
  });

  if (!match) {
    const error = new Error("Match not found");
    error.statusCode = 404;
    throw error;
  }

  if (match.status === "RESOLVED") {
    const error = new Error("Match already resolved");
    error.statusCode = 400;
    throw error;
  }

  const { gameId } = match;
  const marketPda = match.markets[0]?.marketPda;

  logger.info("Playing round", { matchId, gameId, round: match.roundNumber });

  // Activate match if still pending
  if (match.status === "PENDING") {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "ACTIVE" },
    });
  }

  // 1. Initial Deal
  await solanaService.vrfStep(gameId, ROLL_TYPE.INITIAL_DEAL);

  // 2. Agent Decisions — strategic hit/stay loop
  let gameState = await solanaService.fetchGameState(gameId);
  await runAgentTurns(gameId, gameState, match);

  // 3. River Card (Final Reveal)
  await solanaService.vrfStep(gameId, ROLL_TYPE.FINAL_REVEAL);

  // 4. Resolve Round
  try {
    await solanaService.resolveRound(gameId, marketPda);
  } catch (error) {
    // If market already resolved, that's fine (game contract handles it)
    if (!error.logs?.some((l) => l.includes("MarketAlreadyResolved"))) {
      throw error;
    }
    logger.warn("Market already resolved, continuing", { gameId });
  }

  // 5. Check for tiebreaker
  gameState = await solanaService.fetchGameState(gameId);
  let phase = parseGamePhase(gameState.phase);

  while (phase === "AWAITING_TIEBREAKER_VRF") {
    logger.info("Tiebreaker — sudden death", { gameId });
    await solanaService.vrfStep(gameId, ROLL_TYPE.TIEBREAKER);

    try {
      await solanaService.resolveRound(gameId, marketPda);
    } catch (error) {
      if (!error.logs?.some((l) => l.includes("MarketAlreadyResolved"))) {
        throw error;
      }
    }

    gameState = await solanaService.fetchGameState(gameId);
    phase = parseGamePhase(gameState.phase);
  }

  // 6. Sync state to Prisma
  const updatedMatch = await syncMatchState(match, gameState);

  return {
    match: updatedMatch,
    gameState: serializeGameState(gameState),
  };
}

/**
 * Run agent turns (hit/stay) for both Red and Blue.
 * Each agent evaluates their hand using the AI strategy module.
 */
async function runAgentTurns(gameId, initialGameState, match) {
  let gameState = initialGameState;

  // Red goes first
  if (!gameState.p1Stayed) {
    await runSingleAgentTurn(gameId, "RED", gameState, match);
    gameState = await solanaService.fetchGameState(gameId);
  }

  // Then Blue
  if (!gameState.p2Stayed) {
    await runSingleAgentTurn(gameId, "BLUE", gameState, match);
  }
}

/**
 * Run a single agent's turn — loop hit/stay until the agent stays
 * or is forced to stay (score >= 21).
 */
async function runSingleAgentTurn(gameId, player, gameState, match) {
  const isRed = player === "RED";
  let myScore = isRed ? gameState.p1Score : gameState.p2Score;
  let opponentScore = isRed ? gameState.p2Score : gameState.p1Score;
  const myHp = isRed ? match.redHp : match.blueHp;
  const opponentHp = isRed ? match.blueHp : match.redHp;
  const roundNumber = match.roundNumber;

  let stayed = isRed ? gameState.p1Stayed : gameState.p2Stayed;

  while (!stayed) {
    const decision = decideAction({
      myScore,
      opponentScore,
      myHp,
      opponentHp,
      roundNumber,
      player,
    });

    if (decision === "HIT") {
      // Request VRF for hit
      await solanaService.vrfStep(gameId, ROLL_TYPE.HIT);

      // Re-fetch to see updated score
      const updatedState = await solanaService.fetchGameState(gameId);
      myScore = isRed ? updatedState.p1Score : updatedState.p2Score;
      opponentScore = isRed ? updatedState.p2Score : updatedState.p1Score;
      stayed = isRed ? updatedState.p1Stayed : updatedState.p2Stayed;

      // Contract may have forced a stay if score >= 21
      if (stayed) {
        logger.info("Agent force-stayed by contract", { player, myScore });
        return;
      }
    } else {
      // Stay
      await solanaService.stay(gameId, player);
      return;
    }
  }
}

// ── Match State Sync ────────────────────────────────────────────────

/**
 * Synchronize on-chain GameState back to the Prisma Match record.
 */
async function syncMatchState(match, gameState) {
  const phase = parseGamePhase(gameState.phase);
  const isEnded = phase === "ENDED";

  const updateData = {
    redHp: gameState.p1Hp,
    blueHp: gameState.p2Hp,
    roundNumber: gameState.roundNumber,
    status: isEnded ? "RESOLVED" : "ACTIVE",
  };

  const updatedMatch = await prisma.match.update({
    where: { id: match.id },
    data: updateData,
  });

  // If game ended, sync market resolution
  if (isEnded) {
    const winner = parseColor(gameState.winner);
    const winningOutcome = winner === "RED" ? "YES" : "NO";

    await prisma.market.updateMany({
      where: { matchId: match.id, marketType: "MAIN" },
      data: {
        status: "RESOLVED",
        winningOutcome,
        resolvesAt: new Date(),
      },
    });

    logger.info("Match ended", {
      matchId: match.id,
      gameId: match.gameId,
      winner,
    });
  }

  return updatedMatch;
}

// ── Multi-Round Automation ──────────────────────────────────────────

/**
 * Play multiple rounds until the match ends or the round limit is hit.
 *
 * @param {string} matchId - Prisma match ID
 * @param {number} maxRounds - Maximum rounds to play (safety limit)
 * @returns {Object} Final match state and game state
 */
export async function playUntilResolved(matchId, maxRounds = 10) {
  let roundsPlayed = 0;
  let result;

  while (roundsPlayed < maxRounds) {
    result = await playRound(matchId);
    roundsPlayed++;

    if (result.match.status === "RESOLVED") {
      logger.info("Match resolved", {
        matchId,
        roundsPlayed,
        winner: result.gameState.winner,
      });
      break;
    }
  }

  return { ...result, roundsPlayed };
}

// ── Query Functions ─────────────────────────────────────────────────

/**
 * Get match details with markets included.
 */
export async function getMatchState(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      markets: true,
    },
  });

  if (!match) {
    const error = new Error("Match not found");
    error.statusCode = 404;
    throw error;
  }

  // Optionally hydrate with on-chain state if match is active
  let liveGameState = null;
  if (match.status !== "RESOLVED") {
    try {
      const gs = await solanaService.fetchGameState(match.gamePda);
      liveGameState = serializeGameState(gs);
    } catch (error) {
      logger.warn("Failed to fetch live game state", {
        matchId,
        error: error.message,
      });
    }
  }

  return { match, liveGameState };
}

/**
 * Get the currently active match (if any).
 */
export async function getActiveMatch() {
  const match = await prisma.match.findFirst({
    where: { status: "ACTIVE" },
    include: { markets: true },
    orderBy: { createdAt: "desc" },
  });

  return match;
}

/**
 * List matches with optional status filter and pagination.
 */
export async function listMatches({ status, page = 1, limit = 20 } = {}) {
  const where = status ? { status } : {};
  const skip = (page - 1) * limit;

  const [matches, total] = await Promise.all([
    prisma.match.findMany({
      where,
      include: { markets: { select: { id: true, slug: true, status: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.match.count({ where }),
  ]);

  return {
    matches,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * Convert an Anchor GameState account into a plain JSON-safe object.
 */
function serializeGameState(gs) {
  return {
    gameId: gs.gameId?.toNumber?.() ?? gs.gameId,
    agentRed: gs.agentRed?.toBase58?.() ?? gs.agentRed,
    agentBlue: gs.agentBlue?.toBase58?.() ?? gs.agentBlue,
    p1Hp: gs.p1Hp,
    p2Hp: gs.p2Hp,
    p1Score: gs.p1Score,
    p2Score: gs.p2Score,
    p1Aces: gs.p1Aces,
    p2Aces: gs.p2Aces,
    p1Stayed: gs.p1Stayed,
    p2Stayed: gs.p2Stayed,
    roundNumber: gs.roundNumber,
    phase: parseGamePhase(gs.phase),
    activePlayer: parseColor(gs.activePlayer),
    winner: gs.winner ? parseColor(gs.winner) : null,
  };
}
