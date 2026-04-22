import { Router } from "express";
import {
  startMatchController,
  advanceMatchController,
  listMatchesController,
  activeMatchController,
  getMatchController,
} from "../controllers/game.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

export const gameRoutes = Router();

// Public endpoints
gameRoutes.get("/", asyncHandler(listMatchesController));
gameRoutes.get("/active", asyncHandler(activeMatchController));
gameRoutes.get("/:matchId", asyncHandler(getMatchController));

// Admin/crank endpoints (no auth middleware — secured by crank wallet on-chain)
gameRoutes.post("/start", asyncHandler(startMatchController));
gameRoutes.post("/:matchId/advance", asyncHandler(advanceMatchController));
