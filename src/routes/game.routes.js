import { Router } from "express";
import {
  startMatchController,
  advanceMatchController,
  listMatchesController,
  activeMatchController,
  getMatchController,
  pauseMatchController,
  resumeMatchController,
  countdownController,
} from "../controllers/game.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAdminKey } from "../middlewares/admin-auth.js";

export const gameRoutes = Router();

// Public endpoints
gameRoutes.get("/", asyncHandler(listMatchesController));
gameRoutes.get("/active", asyncHandler(activeMatchController));
gameRoutes.get("/countdown", asyncHandler(countdownController));
gameRoutes.get("/:matchId", asyncHandler(getMatchController));

// Admin/crank endpoints (no auth middleware — secured by crank wallet on-chain)
gameRoutes.post("/start", asyncHandler(startMatchController));
gameRoutes.post("/:matchId/advance", asyncHandler(advanceMatchController));

// Admin-secured endpoints (require x-admin-key header)
gameRoutes.post("/:matchId/pause", requireAdminKey, asyncHandler(pauseMatchController));
gameRoutes.post("/:matchId/resume", requireAdminKey, asyncHandler(resumeMatchController));
