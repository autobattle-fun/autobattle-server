import { Router } from "express";
import {
  createMarket,
  dealCards,
  agentStay,
  agentHit,
  revealRiver,
  resolveRound,
  resolveTiebreaker,
  getGameStats,
} from "../controllers/test.controller.js";

export const testRoutes = Router();

// Setup
testRoutes.get("/create-market", createMarket);

// Game Loop (Requires the gameId returned from create-market)
testRoutes.get("/deal-cards/:gameId", dealCards);
testRoutes.get("/stay/:gameId/:player", agentStay); // player = 'red' or 'blue'
testRoutes.get("/hit/:gameId/:player", agentHit); // player = 'red' or 'blue'
testRoutes.get("/reveal-river/:gameId", revealRiver);
testRoutes.get("/resolve-round/:gameId", resolveRound);
testRoutes.get("/tiebreaker/:gameId", resolveTiebreaker);

testRoutes.get("/stats/:gameId", getGameStats);
