import {
  getMarketDetails,
  listMarketsForMatch,
  getSharePrices,
  recordPrediction,
  listPredictionsForMarket,
  getUserPredictions,
} from "../services/market.service.js";
import {
  validate,
  recordPredictionSchema,
  listPredictionsSchema,
} from "../utils/validators.js";

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
 * GET /me/predictions
 * Get authenticated user's predictions across all markets.
 */
export async function myPredictionsController(request, response) {
  if (!request.auth?.user) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const predictions = await getUserPredictions(request.auth.user.id, {
    matchId: request.query.matchId,
    marketId: request.query.marketId,
  });

  return response.json({
    success: true,
    data: predictions,
  });
}
