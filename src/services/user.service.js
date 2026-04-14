import { prisma } from "../db/prisma.js";

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
