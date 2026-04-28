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
  getMarketPrices,
  getUserPosition,
  fireEventMethods,
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

testRoutes.get("/prices/:marketId", getMarketPrices);
testRoutes.get("/user-position/:marketId/:userPubkey", getUserPosition);

// --- WEBSOCKET EVENT TESTING ROUTES ---
testRoutes.get("/fire-event/match-created", fireEventMethods.fireMatchCreated);
testRoutes.get("/fire-event/round-started", fireEventMethods.fireRoundStarted);
testRoutes.get("/fire-event/cards-dealt", fireEventMethods.fireCardsDealt);
testRoutes.get("/fire-event/agent-decision", fireEventMethods.fireAgentDecision);
testRoutes.get("/fire-event/river-revealed", fireEventMethods.fireRiverRevealed);
testRoutes.get("/fire-event/round-resolved", fireEventMethods.fireRoundResolved);
testRoutes.get("/fire-event/tiebreaker-started", fireEventMethods.fireTiebreakerStarted);
testRoutes.get("/fire-event/tiebreaker-resolved", fireEventMethods.fireTiebreakerResolved);
testRoutes.get("/fire-event/hp-updated", fireEventMethods.fireHpUpdated);
testRoutes.get("/fire-event/game-stats", fireEventMethods.fireGameStats);
testRoutes.get("/fire-event/match-ended", fireEventMethods.fireMatchEnded);
testRoutes.get("/fire-event/game-paused", fireEventMethods.fireGamePaused);
testRoutes.get("/fire-event/game-resumed", fireEventMethods.fireGameResumed);
testRoutes.get("/fire-event/break-countdown", fireEventMethods.fireBreakCountdown);
testRoutes.get("/fire-event/break-preparing", fireEventMethods.fireBreakPreparing);
testRoutes.get("/fire-event/market-prices", fireEventMethods.fireMarketPrices);
testRoutes.get("/fire-event/log-broadcast", fireEventMethods.fireLogBroadcast);
testRoutes.get("/fire-event/pong", fireEventMethods.firePong);

