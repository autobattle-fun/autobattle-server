import crypto from "node:crypto";
import { env } from "../config/env.js";
import { redis } from "../db/redis.js";

const sessionPrefix = "autobattle:session:";

function buildSessionKey(sessionToken) {
  return `${sessionPrefix}${sessionToken}`;
}

export async function createSession({ userId, privyUserId }) {
  const sessionToken = crypto.randomUUID();
  const key = buildSessionKey(sessionToken);

  const payload = {
    userId,
    privyUserId,
    createdAt: new Date().toISOString(),
  };

  await redis.set(key, JSON.stringify(payload), "EX", env.SESSION_TTL_SECONDS);

  return sessionToken;
}

export async function getSession(sessionToken) {
  if (!sessionToken) {
    return null;
  }

  const serialized = await redis.get(buildSessionKey(sessionToken));

  if (!serialized) {
    return null;
  }

  return JSON.parse(serialized);
}

export async function destroySession(sessionToken) {
  if (!sessionToken) {
    return;
  }

  await redis.del(buildSessionKey(sessionToken));
}

export async function refreshSession(sessionToken) {
  if (!sessionToken) {
    return;
  }

  await redis.expire(buildSessionKey(sessionToken), env.SESSION_TTL_SECONDS);
}
