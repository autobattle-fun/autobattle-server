import { env } from "../config/env.js";

export async function verifyAccessToken(accessToken) {
  try {
    const response = await fetch(
      "https://api.openfort.io/iam/v2/auth/get-session",
      {
        headers: {
          "Content-Type": "application/json",
          "x-project-key": env.OPENFORT_PROJECT_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        method: "GET",
      },
    );
    const data = await response.json();
    return data;
  } catch {
    throw new Error("Failed to verify authentication token");
  }
}
