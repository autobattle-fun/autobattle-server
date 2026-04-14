import { env } from "./env.js";

export function buildSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.SESSION_COOKIE_SECURE || env.NODE_ENV === "production",
    path: "/",
    maxAge: env.SESSION_TTL_SECONDS * 1000,
  };
}
