import { Router } from "express";
import {
  authLogoutController,
  authSessionController,
  authUsernameController,
} from "../controllers/auth.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

export const authRoutes = Router();

authRoutes.post("/session", asyncHandler(authSessionController));
authRoutes.post("/username", asyncHandler(authUsernameController));
authRoutes.post("/logout", asyncHandler(authLogoutController));
