import { Router } from "express";
import {
  getMarketController,
  listMarketsController,
  marketPriceController,
  recordPredictionController,
  listPredictionsController,
  myPredictionsController,
  getRoundMarketController,
} from "../controllers/market.controller.js";
import { requireAuth } from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const marketRoutes = Router();

// Static routes MUST come before parameterised routes
marketRoutes.get(
  "/me/predictions",
  requireAuth,
  asyncHandler(myPredictionsController),
);
marketRoutes.get("/match/:matchId", asyncHandler(listMarketsController));
marketRoutes.get("/game/:gameId/round/:roundNumber", asyncHandler(getRoundMarketController));

// Parameterised routes
marketRoutes.get("/:marketId", asyncHandler(getMarketController));
marketRoutes.get("/:marketId/price", asyncHandler(marketPriceController));
marketRoutes.get(
  "/:marketId/predictions",
  asyncHandler(listPredictionsController),
);
marketRoutes.post(
  "/:marketId/predictions",
  requireAuth,
  asyncHandler(recordPredictionController),
);
