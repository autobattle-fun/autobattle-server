import throng from "throng";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./db/prisma.js";
import { redis } from "./db/redis.js";
import { startCrankEngine, stopCrankEngine } from "./lib/crank.js";
import { initWebSocket } from "./lib/websocket.js";
import { startTelegramBot, stopTelegramBot } from "./lib/telegram.js";

async function start(workerId) {
  try {
    await prisma.$connect();
    logger.info("Database connected", {
      workerId,
      env: env.NODE_ENV,
    });

    await redis.ping();
    logger.info("Redis connected", {
      workerId,
      env: env.NODE_ENV,
    });
  } catch (error) {
    logger.error("Backend startup check failed", {
      workerId,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info("API listening", {
      workerId,
      port: env.PORT,
      env: env.NODE_ENV,
    });

    // Initialize WebSocket server on top of HTTP server
    initWebSocket(server);

    // Start crank engine on worker 1 only to avoid duplicates
    if (workerId === 1) {
      startCrankEngine();
      startTelegramBot();
    }
  });

  const shutdown = async () => {
    logger.info("Shutting down API server", { workerId });
    stopCrankEngine();
    stopTelegramBot();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

throng({
  workers: env.API_WORKERS,
  start,
});
