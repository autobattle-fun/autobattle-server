import { Router } from "express";
import {
  buildTradeController,
  verifyTradeController,
  buildSellController,
  verifySellController,
  buildClaimController,
  verifyClaimController,
  retrieveLpController,
} from "../controllers/trade.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAdminKey } from "../middlewares/admin-auth.js";

export const tradeRoutes = Router();

// Trade Operations
tradeRoutes.post("/build", asyncHandler(buildTradeController));
tradeRoutes.post("/verify", asyncHandler(verifyTradeController));

// Sell Operations
tradeRoutes.post("/sell/build", asyncHandler(buildSellController));
tradeRoutes.post("/sell/verify", asyncHandler(verifySellController));

// Claim Operations
tradeRoutes.post("/claim/build", asyncHandler(buildClaimController));
tradeRoutes.post("/claim/verify", asyncHandler(verifyClaimController));

// Admin Operations
tradeRoutes.post("/:marketId/retrieve-lp", requireAdminKey, asyncHandler(retrieveLpController));
