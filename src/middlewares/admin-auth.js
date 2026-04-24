import { env } from "../config/env.js";

/**
 * Middleware that requires a valid admin API key in the x-admin-key header.
 * Used to secure critical endpoints like match pause/resume.
 */
export function requireAdminKey(req, res, next) {
  if (!env.ADMIN_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Admin API key is not configured on the server.",
    });
  }

  const providedKey = req.headers["x-admin-key"];

  if (!providedKey || providedKey !== env.ADMIN_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid or missing admin API key.",
    });
  }

  next();
}
