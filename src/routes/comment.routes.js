import { Router } from "express";
import {
  postComment,
  getMarketComments,
  toggleLikeComment,
} from "../controllers/comment.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAuth } from "../middlewares/auth-session.js";

export const commentRoutes = Router();

// Get comments for a market
commentRoutes.get("/market/:marketId", asyncHandler(getMarketComments));

// Post a comment
commentRoutes.post("/", requireAuth, asyncHandler(postComment));

// Like/Unlike a comment
commentRoutes.post("/:commentId/like", requireAuth, asyncHandler(toggleLikeComment));
