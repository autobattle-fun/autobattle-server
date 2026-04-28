import { Router } from "express";
import { meController, historyController } from "../controllers/user.controller.js";
import { requireAuth } from "../middlewares/auth-session.js";
import { asyncHandler } from "../utils/async-handler.js";

export const userRoutes = Router();

userRoutes.get("/me", requireAuth, asyncHandler(meController));
userRoutes.get("/history", requireAuth, asyncHandler(historyController));

