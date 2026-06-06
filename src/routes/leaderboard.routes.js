import { Router } from "express";
import {
  getLiveLeaderboardController,
  getLastWeekLeaderboardController,
} from "../controllers/leaderboard.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

export const leaderboardRoutes = Router();

leaderboardRoutes.get("/live", asyncHandler(getLiveLeaderboardController));
leaderboardRoutes.get(
  "/last-week",
  asyncHandler(getLastWeekLeaderboardController),
);
