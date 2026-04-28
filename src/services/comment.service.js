import { prisma } from "../db/prisma.js";

export class CommentService {
  static async createComment(userId, marketId, commentText) {
    return await prisma.comment.create({
      data: {
        userId,
        marketId,
        comment: commentText,
      },
      include: {
        user: {
          select: {
            username: true,
          },
        },
      },
    });
  }

  static async getCommentsByMarket(marketId) {
    return await prisma.comment.findMany({
      where: { marketId },
      include: {
        user: {
          select: {
            username: true,
          },
        },
        _count: {
          select: { commentLikes: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  static async toggleLike(userId, commentId) {
    const existingLike = await prisma.commentLike.findFirst({
      where: {
        userId,
        commentId,
      },
    });

    if (existingLike) {
      await prisma.$transaction([
        prisma.commentLike.delete({
          where: { id: existingLike.id },
        }),
        prisma.comment.update({
          where: { id: commentId },
          data: { likes: { decrement: 1 } },
        }),
      ]);
      return { liked: false };
    } else {
      await prisma.$transaction([
        prisma.commentLike.create({
          data: {
            userId,
            commentId,
          },
        }),
        prisma.comment.update({
          where: { id: commentId },
          data: { likes: { increment: 1 } },
        }),
      ]);
      return { liked: true };
    }
  }
}
