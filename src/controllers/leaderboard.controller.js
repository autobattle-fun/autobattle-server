import { redis } from "../db/redis.js";

const LIVE_KEY = "leaderboard:live";
const LAST_WEEK_KEY = "leaderboard:last_week";

export async function getLiveLeaderboardController(_req, res) {
  const data = await redis.get(LIVE_KEY);

  if (!data) {
    return res.status(200).json({
      success: true,
      data: { weekStart: null, updatedAt: null, entries: [] },
    });
  }

  return res.status(200).json({ success: true, data: JSON.parse(data) });
}

export async function getLastWeekLeaderboardController(_req, res) {
  const data = await redis.get(LAST_WEEK_KEY);

  if (!data) {
    return res.status(200).json({
      success: true,
      data: { weekStart: null, updatedAt: null, entries: [] },
    });
  }

  return res.status(200).json({ success: true, data: JSON.parse(data) });
}
