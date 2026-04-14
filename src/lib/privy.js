import { PrivyClient } from "@privy-io/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";

const privy = new PrivyClient({
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
});

const privyJwks = createRemoteJWKSet(
  new URL(`https://auth.privy.io/v1/apps/${env.PRIVY_APP_ID}/jwks.json`),
);

function normalizeVerifiedClaims(rawClaims) {
  return {
    appId: rawClaims.appId || rawClaims.app_id || null,
    issuer: rawClaims.issuer || rawClaims.iss || null,
    issuedAt: rawClaims.issuedAt || rawClaims.issued_at || null,
    expiration: rawClaims.expiration || rawClaims.exp || null,
    sessionId:
      rawClaims.sessionId || rawClaims.session_id || rawClaims.sid || null,
    userId: rawClaims.userId || rawClaims.user_id || rawClaims.sub || null,
  };
}

export async function verifyAccessToken(accessToken) {
  try {
    const claims = await privy
      .utils()
      .auth()
      .verifyAccessToken({ access_token: accessToken });

    return normalizeVerifiedClaims(claims);
  } catch {
    try {
      const { payload } = await jwtVerify(accessToken, privyJwks, {
        typ: "JWT",
        algorithms: ["ES256"],
        issuer: "privy.io",
        audience: env.PRIVY_APP_ID,
      });

      return normalizeVerifiedClaims(payload);
    } catch {
      throw new Error("Failed to verify authentication token");
    }
  }
}
