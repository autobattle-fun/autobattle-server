import { Router } from "express";
import {
  meController,
  historyController,
  predictionDetailController,
  getUserProfile,
  createUser,
  getUserById,
  searchByUsernameController,
} from "../controllers/user.controller.js";
import {
  requireAuth,
  requireOptionalAuth,
} from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const userRoutes = Router();

userRoutes.get("/get/:id", asyncHandler(getUserById));
userRoutes.get("/me", requireAuth, asyncHandler(meController));
userRoutes.get("/profile/:username", asyncHandler(getUserProfile));
userRoutes.get("/search/:username", asyncHandler(searchByUsernameController));
userRoutes.post("/create", requireOptionalAuth, asyncHandler(createUser));

userRoutes.get("/predictions/:username", asyncHandler(historyController));
userRoutes.get(
  "/predictions/get/:id",
  asyncHandler(predictionDetailController),
);
