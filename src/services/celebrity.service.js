import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";

const CACHE_KEY = "autobattle:celebrities";
const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * Fetch all celebrities from Redis cache or database.
 * @returns {Promise<Array<{name: string, image: string, prompt: string}>>}
 */
export async function getCelebrities() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const celebrities = await prisma.celebrity.findMany();

  if (celebrities.length > 0) {
    await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(celebrities));
  }

  return celebrities;
}

/**
 * Get a specific celebrity by name.
 */
export async function getCelebrityByName(name) {
  const all = await getCelebrities();
  return all.find((c) => c.name === name) || null;
}
