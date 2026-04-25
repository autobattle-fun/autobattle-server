import { Router } from "express";
import {
  createMarket,
  dealCards,
  agentStay,
  agentHit,
  revealRiver,
  resolveTiebreaker,
  getGameStats,
  buildTradeTransaction,
  getRoundMarket,
  verifyTrade,
  buildClaimTransaction,
  verifyClaim,
  buildSellTransaction,
  verifySell,
  retrieveLp,
} from "../controllers/test.controller.js";

export const testRoutes = Router();

// Setup
testRoutes.get("/create-market", createMarket);

// Game Loop (Requires the gameId returned from create-market)
testRoutes.get("/deal-cards/:gameId", dealCards);
testRoutes.get("/stay/:gameId/:player", agentStay); // player = 'red' or 'blue'
testRoutes.get("/hit/:gameId/:player", agentHit); // player = 'red' or 'blue'
testRoutes.get("/reveal-river/:gameId", revealRiver);
testRoutes.get("/tiebreaker/:gameId", resolveTiebreaker);

testRoutes.get("/stats/:gameId", getGameStats);

testRoutes.get("/markets/:gameId/round/:roundNumber", getRoundMarket);
testRoutes.post("/build-trade", buildTradeTransaction);
testRoutes.post("/verify-trade", verifyTrade);
testRoutes.post("/build-claim", buildClaimTransaction);
testRoutes.post("/verify-claim", verifyClaim);
testRoutes.post("/build-sell", buildSellTransaction);
testRoutes.post("/verify-sell", verifySell);
testRoutes.get("/retrieve-lp/:marketId", retrieveLp);
