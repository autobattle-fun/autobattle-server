import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { solanaService } from "./solana.service.js";
import { parseOutcome } from "../utils/solana.helpers.js";

// ── Market Queries ──────────────────────────────────────────────────

/**
 * Get full market details: Prisma record + live on-chain state (share supplies, prices).
 */
export async function getMarketDetails(marketId) {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: {
      match: {
        select: {
          id: true,
          gameId: true,
          status: true,
          redHp: true,
          blueHp: true,
          roundNumber: true,
        },
      },
      _count: { select: { predictions: true } },
    },
  });

  if (!market) {
    const error = new Error("Market not found");
    error.statusCode = 404;
    throw error;
  }

  // Hydrate with on-chain data
  let onChainState = null;
  try {
    const mkt = await solanaService.fetchMarketState(market.marketPda);
    onChainState = serializeMarketState(mkt);
  } catch (error) {
    logger.warn("Failed to fetch on-chain market state", {
      marketId,
      error: error.message,
    });
  }

  return { market, onChainState };
}

/**
 * List all markets for a given match.
 */
export async function listMarketsForMatch(matchId) {
  const markets = await prisma.market.findMany({
    where: { matchId },
    include: {
      _count: { select: { predictions: true } },
    },
    orderBy: { marketIndex: "asc" },
  });

  return markets;
}

/**
 * List all markets with pagination.
 */
export async function listAllMarkets({ page = 1, limit = 10, status } = {}) {
  const skip = (page - 1) * limit;
  const where = {};
  if (status) {
    where.status = status;
  }

  const [markets, total] = await Promise.all([
    prisma.market.findMany({
      where,
      include: {
        _count: { select: { predictions: true } },
        match: {
          select: {
            id: true,
            gameId: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.market.count({ where }),
  ]);

  return {
    markets,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get share prices from on-chain LMSR AMM data.
 *
 * LMSR pricing:
 *   P(yes) = yesSupply / (yesSupply + noSupply)
 *   P(no)  = noSupply / (yesSupply + noSupply)
 *
 * Returns normalized prices between 0 and 1.
 */
export async function getSharePrices(marketPda) {
  const mkt = await solanaService.fetchMarketState(marketPda);
  return computePrices(mkt);
}

/**
 * Compute LMSR prices from a raw market account.
 */
function computePrices(marketAccount) {
  const yesSupply = Number(marketAccount.yesSupply);
  const noSupply = Number(marketAccount.noSupply);
  const total = yesSupply + noSupply;

  if (total === 0) {
    return { yesPrice: 0.5, noPrice: 0.5, totalVolume: 0 };
  }

  return {
    yesPrice: yesSupply / total,
    noPrice: noSupply / total,
    totalVolume: Number(marketAccount.totalVolume),
  };
}

// ── Prediction Recording ────────────────────────────────────────────

/**
 * Record a user's prediction in Prisma AFTER their on-chain buy_shares
 * transaction has been confirmed.
 *
 * This is an off-chain record for frontend display / tracking.
 * The actual position is enforced on-chain via the UserPosition PDA.
 */
export async function recordPrediction({
  userId,
  marketId,
  side,
  amount,
  positionPda,
  txSignature,
}) {
  // Validate the market exists and is open
  const market = await prisma.market.findUnique({
    where: { id: marketId },
  });

  if (!market) {
    const error = new Error("Market not found");
    error.statusCode = 404;
    throw error;
  }

  if (market.status !== "OPEN") {
    const error = new Error("Market is no longer open for predictions");
    error.statusCode = 400;
    throw error;
  }

  // Verify the on-chain transaction exists (optional but recommended)
  try {
    const tx = await solanaService.connection.getTransaction(txSignature, {
      commitment: "confirmed",
    });

    if (!tx) {
      const error = new Error(
        "Transaction not found or not yet confirmed on-chain",
      );
      error.statusCode = 400;
      throw error;
    }
  } catch (error) {
    if (error.statusCode) throw error;
    logger.warn("Could not verify transaction", {
      txSignature,
      error: error.message,
    });
  }

  // Check for duplicate prediction (same user, same market, same position PDA)
  const existing = await prisma.prediction.findUnique({
    where: { positionPda },
  });

  if (existing) {
    const error = new Error("Prediction already recorded for this position");
    error.statusCode = 409;
    throw error;
  }

  const prediction = await prisma.prediction.create({
    data: {
      userId,
      marketId,
      side,
      amount,
      positionPda,
    },
  });

  logger.info("Prediction recorded", {
    predictionId: prediction.id,
    userId,
    marketId,
    side,
    amount,
  });

  return prediction;
}

// ── User Positions ──────────────────────────────────────────────────

/**
 * List all predictions for a specific market with pagination.
 */
export async function listPredictionsForMarket(
  marketId,
  { page = 1, limit = 20 } = {},
) {
  const skip = (page - 1) * limit;

  const [predictions, total] = await Promise.all([
    prisma.prediction.findMany({
      where: { marketId },
      include: {
        user: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.prediction.count({ where: { marketId } }),
  ]);

  return {
    predictions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ── Market Resolution Sync ──────────────────────────────────────────

/**
 * Sync on-chain market resolution status to Prisma.
 * Called after a match resolves to update market records.
 */
export async function syncMarketResolution(marketId) {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
  });

  if (!market || market.status === "RESOLVED") {
    return market;
  }

  try {
    const onChain = await solanaService.fetchMarketState(market.marketPda);

    if (onChain.resolved) {
      const outcome = onChain.outcome ? parseOutcome(onChain.outcome) : null;

      return prisma.market.update({
        where: { id: marketId },
        data: {
          status: "RESOLVED",
          winningOutcome: outcome,
          resolvesAt: new Date(),
        },
      });
    }
  } catch (error) {
    logger.warn("Failed to sync market resolution", {
      marketId,
      error: error.message,
    });
  }

  return market;
}

// ── Serialization ───────────────────────────────────────────────────

function serializeMarketState(mkt) {
  return {
    gameId: Number(mkt.gameId),
    marketIndex: mkt.marketIndex,
    question: mkt.question,
    yesSupply: Number(mkt.yesSupply),
    noSupply: Number(mkt.noSupply),
    totalVolume: Number(mkt.totalVolume),
    resolved: mkt.resolved,
    outcome: mkt.outcome ? parseOutcome(mkt.outcome) : null,
    expiresAt: Number(mkt.expiresAt),
    claimsRemaining: Number(mkt.claimsRemaining),
    ...computePrices(mkt),
  };
}
