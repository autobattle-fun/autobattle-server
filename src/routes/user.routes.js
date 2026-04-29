import { Router } from "express";
import {
  meController,
  historyController,
  predictionDetailController,
} from "../controllers/user.controller.js";
import { requireAuth } from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const userRoutes = Router();

userRoutes.get("/me", requireAuth, asyncHandler(meController));

userRoutes.get("/predictions", requireAuth, asyncHandler(historyController));
userRoutes.get("/predictions/:id", asyncHandler(predictionDetailController));
