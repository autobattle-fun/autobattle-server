import IORedis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("error", (error) => {
  logger.error("Redis connection error", {
    error: error instanceof Error ? error.message : String(error),
  });
});
