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

  static async getCommentsByMarket(marketId, userId = null, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [comments, totalCount] = await Promise.all([
      prisma.comment.findMany({
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
          commentLikes: userId
            ? {
                where: { userId },
                select: { id: true },
              }
            : false,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.comment.count({ where: { marketId } }),
    ]);

    const formattedComments = comments.map((c) => ({
      ...c,
      isLiked: userId ? c.commentLikes.length > 0 : false,
      commentLikes: undefined,
    }));

    return {
      comments: formattedComments,
      pagination: {
        totalCount,
        page,
        limit,
        hasMore: skip + formattedComments.length < totalCount,
      },
    };
  }

  static async toggleLike(userId, commentId, liked) {
    const existingLike = await prisma.commentLike.findFirst({
      where: {
        userId,
        commentId,
      },
    });

    // If 'liked' is provided, we use it as the target state.
    // Otherwise, we toggle the existing state.
    const shouldBeLiked = liked !== undefined ? liked : !existingLike;

    if (shouldBeLiked && !existingLike) {
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
    } else if (!shouldBeLiked && existingLike) {
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
    }

    return { liked: !!existingLike };
  }
}
