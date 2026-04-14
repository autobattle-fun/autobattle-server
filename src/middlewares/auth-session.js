import { getSession, refreshSession } from "../services/session.service.js";
import { findUserById, findUserByPrivyId } from "../services/user.service.js";
import { verifyAccessToken } from "../lib/privy.js";
import { getBearerToken } from "../utils/auth-token.js";
import { env } from "../config/env.js";

export async function attachAuthContext(request, _response, next) {
  request.auth = {
    user: null,
    claims: null,
    sessionToken: request.cookies?.[env.SESSION_COOKIE_NAME] || null,
  };

  if (request.path?.startsWith("/auth/")) {
    return next();
  }

  try {
    if (request.auth.sessionToken) {
      const session = await getSession(request.auth.sessionToken);

      if (session?.userId) {
        const user = await findUserById(session.userId);

        if (user) {
          request.auth.user = user;
          await refreshSession(request.auth.sessionToken);
          return next();
        }
      }
    }

    const accessToken = getBearerToken(request);

    if (!accessToken) {
      return next();
    }

    const claims = await verifyAccessToken(accessToken);
    const user = await findUserByPrivyId(claims.userId);

    request.auth.claims = claims;
    request.auth.user = user || null;

    return next();
  } catch (error) {
    const authError = new Error("Invalid or expired access token.");
    authError.statusCode = 401;
    return next(authError);
  }
}

export function requireAuth(request, _response, next) {
  if (!request.auth?.user) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    return next(error);
  }

  return next();
}
