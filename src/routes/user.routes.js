import { Router } from "express";
import {
  meController,
  historyController,
  predictionDetailController,
  getUserById,
  createUser,
} from "../controllers/user.controller.js";
import {
  requireAuth,
  requireOptionalAuth,
} from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const userRoutes = Router();

userRoutes.get("/me", requireAuth, asyncHandler(meController));
userRoutes.get("/get/:userId", asyncHandler(getUserById));
userRoutes.post("/create", requireOptionalAuth, asyncHandler(createUser));

userRoutes.get("/predictions/:username", asyncHandler(historyController));
userRoutes.get(
  "/predictions/get/:id",
  asyncHandler(predictionDetailController),
);
