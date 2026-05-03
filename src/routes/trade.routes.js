import { Router } from "express";
import {
  buildTradeController,
  verifyTradeController,
  buildSellController,
  verifySellController,
  buildClaimController,
  verifyClaimController,
  retrieveLpController,
  getMyMarketSharesController,
  buildTransferController,
  verifyTransferController,
} from "../controllers/trade.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAdminKey } from "../middlewares/admin-auth.js";
import { requireAuth } from "../middlewares/auth-session.js";

export const tradeRoutes = Router();

tradeRoutes.get(
  "/my-shares/:marketId",
  requireAuth,
  asyncHandler(getMyMarketSharesController),
);

// Trade Operations
tradeRoutes.post("/build", requireAuth, asyncHandler(buildTradeController));
tradeRoutes.post("/verify", requireAuth, asyncHandler(verifyTradeController));

// Sell Operations
tradeRoutes.post("/sell/build", requireAuth, asyncHandler(buildSellController));
tradeRoutes.post(
  "/sell/verify",
  requireAuth,
  asyncHandler(verifySellController),
);

// Claim Operations
tradeRoutes.post(
  "/claim/build",
  requireAuth,
  asyncHandler(buildClaimController),
);
tradeRoutes.post(
  "/claim/verify",
  requireAuth,
  asyncHandler(verifyClaimController),
);

// Transfer Operations
tradeRoutes.post(
  "/transfer/build",
  requireAuth,
  asyncHandler(buildTransferController),
);
tradeRoutes.post(
  "/transfer/verify",
  requireAuth,
  asyncHandler(verifyTransferController),
);

// Admin Operations
tradeRoutes.post(
  "/:marketId/retrieve-lp",
  requireAdminKey,
  asyncHandler(retrieveLpController),
);
