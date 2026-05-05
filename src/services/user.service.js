import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { logger } from "../lib/logger.js";

export async function findUserById(id) {
  return prisma.user.findUnique({ where: { id } });
}

export async function findUserByPrivyId(privyUserId) {
  return prisma.user.findUnique({ where: { privyUserId } });
}

export async function findUserByUsername(username) {
  return prisma.user.findUnique({ where: { username } });
}

export async function touchUserLastLogin(id) {
  return prisma.user.update({
    where: { id },
    data: {
      lastLoginAt: new Date(),
    },
  });
}

export async function createUser({
  privyUserId,
  username,
  authProvider,
  walletAddress,
  email,
}) {
  return prisma.user.create({
    data: {
      privyUserId,
      username,
      authProvider: authProvider || "privy",
      walletAddress: walletAddress || null,
      email: email || null,
      status: "active",
    },
  });
}

export async function updateUserAuthProfile({
  privyUserId,
  authProvider,
  walletAddress,
  email,
}) {
  const data = {};

  if (authProvider) {
    data.authProvider = authProvider;
  }

  if (walletAddress !== undefined) {
    data.walletAddress = walletAddress || null;
  }

  if (email !== undefined) {
    data.email = email || null;
  }

  if (Object.keys(data).length === 0) {
    return null;
  }

  return prisma.user.update({
    where: { privyUserId },
    data,
  });
}

export async function getUserHistory(userId, page = 1, limit = 10) {
  const cacheKey = `user:${userId}:history:p${page}:l${limit}`;
  const skip = (page - 1) * limit;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn("Redis history cache read error", {
      userId,
      error: err.message,
    });
  }

  const [predictions, total] = await Promise.all([
    prisma.prediction.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        side: true,
        amount: true,
        shareAmount: true,
        hasClaimed: true,
        createdAt: true,
        // Wrap market fields in a nested select
        market: {
          select: {
            id: true,
            marketIndex: true,
            marketType: true,
            status: true,
            winningOutcome: true,
            targetRound: true,
            // Wrap match fields in another nested select
            match: {
              select: {
                gameId: true,
                redName: true,
                blueName: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.prediction.count({ where: { userId } }),
  ]);

  const result = {
    predictions,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };

  try {
    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(result));
  } catch (err) {
    logger.warn("Redis history cache write error", {
      userId,
      error: err.message,
    });
  }

  return result;
}

export async function getPredictionDetail(predictionId) {
  const cacheKey = `prediction:${predictionId}:detail`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn("Redis prediction cache read error", {
      predictionId,
      error: err.message,
    });
  }

  const prediction = await prisma.prediction.findUnique({
    where: { id: predictionId },
    select: {
      id: true,
      userId: true,
      side: true,
      amount: true,
      shareAmount: true,
      hasClaimed: true,
      createdAt: true,
      // Wrap market fields in a nested select
      market: {
        select: {
          id: true,
          marketIndex: true,
          marketType: true,
          status: true,
          winningOutcome: true,
          targetRound: true,
          // Wrap match fields in another nested select
          match: {
            select: {
              gameId: true,
              redName: true,
              blueName: true,
            },
          },
        },
      },
    },
  });

  if (prediction) {
    try {
      // Cache for 10 minutes (details change less frequently once resolved)
      await redis.setex(cacheKey, 600, JSON.stringify(prediction));
    } catch (err) {
      logger.warn("Redis prediction cache write error", {
        predictionId,
        error: err.message,
      });
    }
  }

  return prediction;
}
