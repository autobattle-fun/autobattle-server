import { env } from "../config/env.js";

export const createOpenfortSession = async (req, res) => {
  const response = await fetch(
    "https://shield.openfort.io/project/encryption-session",
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.OPENFORT_PUBLISHABLE_KEY,
        "x-api-secret": env.OPENFORT_SECRET_KEY,
      },
      method: "POST",
      body: JSON.stringify({
        encryption_part: env.OPENFORT_ENCRYPTION_SHARE,
      }),
    },
  );

  const data = await response.json();

  res.status(200).send({
    session: data?.session_id,
  });
};
