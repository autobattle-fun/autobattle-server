import { buildSessionCookieOptions } from "../config/cookie.js";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../lib/privy.js";
import { createSession, destroySession } from "../services/session.service.js";
import {
  createUser,
  findUserByPrivyId,
  findUserByUsername,
  touchUserLastLogin,
  updateUserAuthProfile,
} from "../services/user.service.js";
import { getBearerToken } from "../utils/auth-token.js";
import { validateUsername } from "../utils/username.js";

function setSessionCookie(response, sessionToken) {
  response.cookie(
    env.SESSION_COOKIE_NAME,
    sessionToken,
    buildSessionCookieOptions(),
  );
}

function handleInvalidAccessToken(response, error) {
  const baseError = "Invalid or expired access token.";
  const detail =
    env.NODE_ENV === "production"
      ? baseError
      : `${baseError} ${error?.message || "Check frontend/backend PRIVY_APP_ID match and verify server restart after env changes."}`;

  return response.status(401).json({
    error: detail,
  });
}

function normalizeAuthProvider(rawAuthProvider) {
  if (!rawAuthProvider) {
    return "privy";
  }

  const value = String(rawAuthProvider).toLowerCase();

  if (value.includes("twitter")) {
    return "x";
  }

  if (value.includes("google")) {
    return "google";
  }

  if (value.includes("wallet")) {
    return "wallet";
  }

  if (value.includes("email")) {
    return "email";
  }

  return value;
}

function buildAuthProfile(request) {
  return {
    authProvider: normalizeAuthProvider(request.body?.authProvider),
    walletAddress: request.body?.walletAddress || null,
    email: request.body?.email || null,
  };
}

export async function authSessionController(request, response) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return response.status(401).json({ error: "Missing access token." });
  }

  let claims;

  try {
    claims = await verifyAccessToken(accessToken);
  } catch (error) {
    return handleInvalidAccessToken(response, error);
  }

  const authProfile = buildAuthProfile(request);
  const user = await findUserByPrivyId(claims.userId);

  if (!user) {
    return response.json({
      status: "needs_username",
      user: {
        privyUserId: claims.userId,
        suggestedUsername: "",
        ...authProfile,
      },
    });
  }

  await updateUserAuthProfile({
    privyUserId: claims.userId,
    ...authProfile,
  });
  const refreshedUser = await findUserByPrivyId(claims.userId);
  await touchUserLastLogin(user.id);
  const sessionToken = await createSession({
    userId: user.id,
    privyUserId: claims.userId,
  });
  setSessionCookie(response, sessionToken);

  return response.json({
    status: "authenticated",
    user: refreshedUser || user,
  });
}

export async function authUsernameController(request, response) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return response.status(401).json({ error: "Missing access token." });
  }

  let claims;

  try {
    claims = await verifyAccessToken(accessToken);
  } catch (error) {
    return handleInvalidAccessToken(response, error);
  }

  const username = validateUsername(request.body?.username || "");
  const authProfile = buildAuthProfile(request);

  const existingUser = await findUserByPrivyId(claims.userId);

  if (existingUser) {
    await updateUserAuthProfile({
      privyUserId: claims.userId,
      ...authProfile,
    });
    const refreshedUser = await findUserByPrivyId(claims.userId);
    await touchUserLastLogin(existingUser.id);
    const sessionToken = await createSession({
      userId: existingUser.id,
      privyUserId: claims.userId,
    });
    setSessionCookie(response, sessionToken);

    return response.json({
      status: "authenticated",
      user: refreshedUser || existingUser,
    });
  }

  const conflictingUser = await findUserByUsername(username);

  if (conflictingUser) {
    return response
      .status(409)
      .json({ error: "That username is already taken." });
  }

  const user = await createUser({
    privyUserId: claims.userId,
    username,
    ...authProfile,
  });

  const sessionToken = await createSession({
    userId: user.id,
    privyUserId: claims.userId,
  });
  setSessionCookie(response, sessionToken);

  return response.status(201).json({
    status: "authenticated",
    user,
  });
}

export async function authLogoutController(request, response) {
  const sessionToken = request.cookies?.[env.SESSION_COOKIE_NAME];

  await destroySession(sessionToken);
  response.clearCookie(env.SESSION_COOKIE_NAME, buildSessionCookieOptions());

  return response.status(204).send();
}
