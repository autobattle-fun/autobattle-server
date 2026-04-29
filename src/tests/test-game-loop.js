import { env } from "../config/env.js";

// Override for fast testing
env.CRANK_ENABLED = true;
env.MOCK_SOLANA = true;
env.CRANK_INTERVAL_MS = 5000;
env.PREPARATION_PHASE_SECONDS = 2;
env.MATCHMAKING_PHASE_SECONDS = 2;

import { startMatch, playUntilResolved } from "../services/game.service.js";
import { prisma } from "../db/prisma.js";
import { setMatchBreakCountdown, getMatchBreakCountdown } from "../lib/game-state-store.js";
import { startCrankEngine, stopCrankEngine } from "../lib/crank.js";
import { wsEvents } from "../lib/websocket.js";
import { redis } from "../db/redis.js";

async function runTest() {
  try {
    console.log("Cleaning up old matches and locks...");
    await prisma.match.updateMany({
      where: { status: { in: ["ACTIVE", "MATCHMAKING", "PAUSED"] } },
      data: { status: "RESOLVED" }
    });

    const lockKeys = await redis.keys("autobattle:crank:active_lock:*");
    if (lockKeys.length > 0) {
      await redis.del(...lockKeys);
      console.log(`Cleared ${lockKeys.length} stale locks.`);
    }
    console.log("Setting break to expire immediately (PREPARING) to test auto-start...");
    await setMatchBreakCountdown(Math.floor(Date.now() / 1000), "PREPARING");

    console.log("Starting crank engine...");
    startCrankEngine();

    let matchId = null;
    let resolved = false;
    const testStartTime = new Date();

    console.log("Monitoring match progress (waiting for crank to process)...");
    while (!resolved) {
      const match = await prisma.match.findFirst({
        where: { createdAt: { gte: testStartTime } },
        orderBy: { createdAt: "desc" }
      });

      if (match) {
        if (!matchId) {
          matchId = match.id;
          console.log(`[TEST] Match created by crank: ${match.id}`);
          console.log(`[TEST] Names: ${match.redName} vs ${match.blueName}`);
        }

        if (match.id === matchId) {
          const countdown = await getMatchBreakCountdown();
          let countdownStr = "None";
          if (countdown.isBreak) {
            countdownStr = `${countdown.remainingSeconds}s (${countdown.phase})`;
          }
          console.log(`[TEST] Status: ${match.status} | Round: ${match.roundNumber} | HP: ${match.redHp} vs ${match.blueHp} | Countdown: ${countdownStr}`);

          if (match.status === "RESOLVED") {
            console.log("[TEST] Match resolved!");
            resolved = true;
          }
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    stopCrankEngine();
    console.log("[TEST] Success!");
    process.exit(0);
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

runTest();
