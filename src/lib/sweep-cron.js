import { prisma } from "../db/prisma.js";
import { logger } from "./logger.js";
import { solanaService } from "../services/solana.service.js";
import { env } from "../config/env.js";
import { notifyError } from "./telegram.js";
import { withRetry } from "./transaction-retry.js";

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
      await sweepCycle();
    } catch (error) {
      logger.error("Sweep cycle error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error?.stack,
      });
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

  if (candidates.length === 0) {
    return;
  }

  logger.info(`Found ${candidates.length} markets potentially eligible for sweep.`);

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
    } catch (error) {
      logger.error("Failed to sweep market", {
        marketId: market.id,
        error: error.message,
      });
      // Do not throw, continue to next candidate
      // We can optionally notify telegram for persistent sweep failures
      await notifyError(`[sweepUnclaimed] Failed to sweep market ${market.id}`, error);
    }
  }
}
