import { findUserById } from "../services/user.service.js";
import { getBearerToken } from "../utils/auth-token.js";

import { verifyAccessToken } from "../lib/openfort.js";

export async function attachAuthContext(request, _response, next) {
  request.auth = {
    user: null,
    session: null,
  };

  try {
    const accessToken = getBearerToken(request);

    if (!accessToken) {
      return next();
    }

    const session = await verifyAccessToken(accessToken);

    if (session?.session) {
      request.auth.session = session;
    }

    const user = await findUserById(session?.user?.id);

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

export function requireOptionalAuth(request, _response, next) {
  if (!request.auth?.session) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    return next(error);
  }

  return next();
}
