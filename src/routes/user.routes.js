import { Router } from "express";
import {
  meController,
  historyController,
  predictionDetailController,
  getUserProfile,
  createUser,
} from "../controllers/user.controller.js";
import {
  requireAuth,
  requireOptionalAuth,
} from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const userRoutes = Router();

userRoutes.get("/me", requireAuth, asyncHandler(meController));
userRoutes.get("/profile/:username", asyncHandler(getUserProfile));
userRoutes.post("/create", requireOptionalAuth, asyncHandler(createUser));

userRoutes.get("/predictions/:username", asyncHandler(historyController));
userRoutes.get(
  "/predictions/get/:id",
  asyncHandler(predictionDetailController),
);
