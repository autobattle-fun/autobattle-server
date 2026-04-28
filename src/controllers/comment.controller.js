import { CommentService } from "../services/comment.service.js";
import { asyncHandler } from "../utils/async-handler.js";

export async function postComment(req, res) {
  const { marketId, comment } = req.body;
  const userId = req.auth.user.id;

  if (!marketId || !comment) {
    return res.status(400).json({ error: "marketId and comment are required" });
  }

  const newComment = await CommentService.createComment(userId, marketId, comment);
  res.status(201).json(newComment);
}

export async function getMarketComments(req, res) {
  const { marketId } = req.params;

  if (!marketId) {
    return res.status(400).json({ error: "marketId is required" });
  }

  const comments = await CommentService.getCommentsByMarket(marketId);
  res.json(comments);
}

export async function toggleLikeComment(req, res) {
  const { commentId } = req.params;
  const userId = req.auth.user.id;

  if (!commentId) {
    return res.status(400).json({ error: "commentId is required" });
  }

  const result = await CommentService.toggleLike(userId, commentId);
  res.json(result);
}

