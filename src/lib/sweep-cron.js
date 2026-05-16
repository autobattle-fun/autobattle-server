import { prisma } from "../db/prisma.js";
import { logger } from "./logger.js";
import { solanaService } from "../services/solana.service.js";
import { env } from "../config/env.js";
import { notifyError, sendNotification } from "./telegram.js";
import { withRetry } from "./transaction-retry.js";
import { addRoundSystemLog, addSystemLog } from "./system-log-state-store.js";

let isRunning = false;
let intervalHandle = null;

export function startSweepCron() {
  if (!env.SWEEP_ENABLED) {
    logger.info("Sweep cron DISABLED (SWEEP_ENABLED=false)");
    return;
  }

  if (isRunning) {
    logger.warn("Sweep cron already running, skipping duplicate start");
    return;
  }

  isRunning = true;
  const intervalMs = env.SWEEP_INTERVAL_MS;

  logger.info("Sweep cron STARTED", { intervalMs });

  async function scheduleNext() {
    if (!isRunning) return;
    try {
      const stats = await sweepCycle();
      if (stats && stats.total > 0) {
        const summary = 
          `🧹 <b>Sweep Cycle Summary</b>\n\n` +
          `- <b>Total Candidates:</b> ${stats.total}\n` +
          `- <b>✅ Successfully Swept:</b> ${stats.success}\n` +
          `- <b>⚠️ Skipped:</b> ${stats.skipped}\n` +
          `- <b>❌ Failed:</b> ${stats.failed}`;
        
        await sendNotification(summary);
        await addSystemLog("system", `Sweep cycle finished: ${stats.success} success, ${stats.failed} failed, ${stats.skipped} skipped.`);
      }
    } catch (error) {
      logger.error("Sweep cycle error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error?.stack,
      });
      await notifyError("Sweep Cron Job", error, false);
      await addSystemLog("error", `Sweep cycle fatal error: ${error.message}`);
    }
    if (isRunning) {
      intervalHandle = setTimeout(scheduleNext, intervalMs);
    }
  }

  intervalHandle = setTimeout(scheduleNext, intervalMs);
}

export function stopSweepCron() {
  isRunning = false;
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
  }
  logger.info("Sweep cron STOPPED");
}

async function sweepCycle() {
  const claimWindowMs = 48 * 60 * 60 * 1000;
  const cutoffTime = new Date(Date.now() - claimWindowMs);

  const candidates = await prisma.market.findMany({
    where: {
      status: "RESOLVED",
      resolvesAt: { not: null, lt: cutoffTime },
      sweptAt: null,
    },
    take: 10, // Process in batches
  });

  const stats = {
    total: candidates.length,
    success: 0,
    skipped: 0,
    failed: 0,
  };

  if (candidates.length === 0) {
    return stats;
  }

  logger.info(`Found ${candidates.length} markets potentially eligible for sweep.`);
  await addSystemLog("system", `Starting sweep cycle for ${candidates.length} markets.`);

  for (const market of candidates) {
    try {
      if (env.MOCK_SOLANA) {
        await withRetry(() => solanaService.sweepUnclaimed(market.marketPda, market.vaultPda), {
          label: "sweepUnclaimed:mock",
        });
        await prisma.market.update({
          where: { id: market.id },
          data: { sweptAt: new Date() },
        });
        stats.success++;
        await addRoundSystemLog(market.matchId, "system", "Successfully swept unclaimed funds (MOCK).");
        continue;
      }

      // Verify on-chain state
      const mktState = await solanaService.fetchMarketState(market.marketPda);

      if (!mktState.resolved || !mktState.lpWithdrawn) {
        logger.warn("Market not fully resolved/withdrawn on-chain, skipping sweep", {
          marketId: market.id,
          resolved: mktState.resolved,
          lpWithdrawn: mktState.lpWithdrawn,
        });
        stats.skipped++;
        continue;
      }

      const claimWindowSecs = 48 * 60 * 60;
      const nowUnix = Math.floor(Date.now() / 1000);
      const onChainResolvedAt = Number(mktState.resolvedAt);

      if (nowUnix <= onChainResolvedAt + claimWindowSecs) {
        logger.warn("On-chain claim window not yet expired, skipping sweep", {
          marketId: market.id,
          onChainResolvedAt,
          nowUnix,
        });
        stats.skipped++;
        continue;
      }

      // Perform sweep
      logger.info("Sweeping unclaimed funds for market", { marketId: market.id, marketPda: market.marketPda });

      await withRetry(() => solanaService.sweepUnclaimed(market.marketPda, market.vaultPda), {
        label: "sweepUnclaimed",
      });

      // Update Prisma
      await prisma.market.update({
        where: { id: market.id },
        data: { sweptAt: new Date() },
      });

      logger.info("Successfully swept market", { marketId: market.id });
      stats.success++;
      await addRoundSystemLog(market.matchId, "system", "Successfully swept unclaimed funds.");
    } catch (error) {
      logger.error("Failed to sweep market", {
        marketId: market.id,
        error: error.message,
      });
      stats.failed++;
      await addRoundSystemLog(market.matchId, "system", `Failed to sweep funds: ${error.message}`);
      // Do not throw, continue to next candidate
      // Notify telegram for individual market failures (without pausing the match)
      await notifyError(`[sweepUnclaimed] Market ${market.id}`, error, false);
    }
  }

  return stats;
}
