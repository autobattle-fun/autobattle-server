import {
  getMarketDetails,
  listMarketsForMatch,
  getSharePrices,
  recordPrediction,
  listPredictionsForMarket,
  listAllMarkets,
  listAllMatches,
} from "../services/market.service.js";
import {
  validate,
  recordPredictionSchema,
  listPredictionsSchema,
  listMarketsSchema,
  listMatchesSchema,
} from "../utils/validators.js";
import { prisma } from "../db/prisma.js";

/**
 * GET /markets/:marketId
 * Get market details with on-chain state.
 */
export async function getMarketController(request, response) {
  const { marketId } = request.params;
  const result = await getMarketDetails(marketId);

  return response.json({
    success: true,
    data: result,
  });
}

/**
 * GET /markets/match/:matchId
 * List all markets for a given match.
 */
export async function listMarketsController(request, response) {
  const { matchId } = request.params;
  const markets = await listMarketsForMatch(matchId);

  return response.json({
    success: true,
    data: markets,
  });
}

/**
 * GET /markets/:marketId/price
 * Get current YES/NO share prices from on-chain LMSR data.
 */
export async function marketPriceController(request, response) {
  const { marketId } = request.params;
  const { market } = await getMarketDetails(marketId);
  const prices = await getSharePrices(market.marketPda);

  return response.json({
    success: true,
    data: prices,
  });
}

/**
 * POST /markets/:marketId/predictions
 * Record a user's prediction (after on-chain buy_shares tx).
 * Requires authentication.
 */
export async function recordPredictionController(request, response) {
  if (!request.auth?.user) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const { marketId } = request.params;
  const body = validate(recordPredictionSchema, request.body);

  const prediction = await recordPrediction({
    userId: request.auth.user.id,
    marketId,
    side: body.side,
    amount: body.amount,
    positionPda: body.positionPda,
    txSignature: body.txSignature,
  });

  return response.status(201).json({
    success: true,
    data: prediction,
  });
}

/**
 * GET /markets/:marketId/predictions
 * List predictions for a market (public).
 */
export async function listPredictionsController(request, response) {
  const { marketId } = request.params;
  const params = validate(listPredictionsSchema, request.query || {});
  const result = await listPredictionsForMarket(marketId, params);

  return response.json({
    success: true,
    data: result,
  });
}

/**
 * GET /markets
 * List all markets with pagination.
 */
export async function listAllMarketsController(request, response) {
  const query = validate(listMarketsSchema, request.query || {});
  const result = await listAllMarkets(query);

  return response.json({
    success: true,
    ...result,
  });
}

/**
 * GET /markets/game/:gameId/round/:roundNumber
 * Fetch a specific round's market.
 */
export async function getRoundMarketController(request, response) {
  const gameId = Number(request.params.gameId);
  const roundNumber = Number(request.params.roundNumber);

  if (isNaN(gameId) || isNaN(roundNumber)) {
    return response
      .status(400)
      .json({ success: false, error: "Invalid parameters" });
  }

  try {
    const market = await prisma.market.findFirst({
      where: {
        match: { gameId: gameId },
        marketType: "MID_GAME",
        targetRound: roundNumber,
      },
    });

    if (!market) {
      return response.status(404).json({
        success: false,
        message: `No market found for Match #${gameId}, Round ${roundNumber}`,
      });
    }

    return response.status(200).json({
      success: true,
      data: {
        dbMarketId: market.id,
        marketPda: market.marketPda,
        marketIndex: market.marketIndex,
        status: market.status,
        title: market.title,
      },
    });
  } catch (error) {
    console.error("Fetch round market error:", error);
    return response.status(500).json({ success: false, error: error.message });
  }
}
