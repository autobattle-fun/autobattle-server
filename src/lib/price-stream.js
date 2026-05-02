import { Connection, PublicKey } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { prisma } from "../db/prisma.js";
import { wsEvents } from "./websocket.js";
import { logger } from "./logger.js";
import fs from "fs";
import path from "path";

const LMSR_B_SCALED = 14_427_000_000; // must match Rust contract
const COMMITMENT = "confirmed";

// ── IDL / decoder ───────────────────────────────────────────────────
const idlPath = path.resolve(process.cwd(), "src/idls/prediction_market.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
const coder = new BorshCoder(idl);

// ── Singleton connection state ──────────────────────────────────────
let connection = null;
let refreshTimer = null;
let pingTimer = null;

// map marketPda -> subscription id
const accountSubs = new Map();

// map marketPda -> DB metadata used in broadcasts
const marketCache = new Map();

// map marketPda -> latest decoded market data payload
const latestMarketStates = new Map();

function getWsUrlFromRpcUrl(rpcUrl) {
  if (rpcUrl.startsWith("https://")) return rpcUrl.replace("https://", "wss://");
  if (rpcUrl.startsWith("http://")) return rpcUrl.replace("http://", "ws://");
  return rpcUrl;
}

function getHeliusEndpoints() {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not set");

  return {
    rpcUrl,
    wsUrl: getWsUrlFromRpcUrl(rpcUrl),
  };
}

function calculatePrices(yesSupply, noSupply) {
  const pYes = 1 / (1 + Math.exp((noSupply - yesSupply) / LMSR_B_SCALED));
  const pNo = 1 - pYes;

  return {
    yesPrice: parseFloat(pYes.toFixed(4)),
    noPrice: parseFloat(pNo.toFixed(4)),
  };
}

function decodeMarketAccount(accountInfo) {
  return coder.accounts.decode("market", accountInfo.data);
}

function formatMarketData(cached, decodedMarket) {
  const yesSupply = decodedMarket.yesSupply.toNumber();
  const noSupply = decodedMarket.noSupply.toNumber();
  const { yesPrice, noPrice } = calculatePrices(yesSupply, noSupply);

  return {
    id: cached.id,
    matchId: cached.matchId,
    marketIndex: cached.marketIndex,
    targetRound: cached.targetRound,
    status: decodedMarket.resolved ? "RESOLVED" : "OPEN",
    yesPrice,
    noPrice,
    totalVolumeRaw: decodedMarket.totalVolume.toNumber(),
  };
}

function broadcastCombinedPrices(matchId) {
  const payload = {};
  for (const [pda, cached] of marketCache.entries()) {
    if (cached.matchId === matchId) {
      const state = latestMarketStates.get(pda);
      if (state) {
        if (cached.marketType === "MAIN") {
          payload.mainMarket = state;
        } else {
          payload.roundMarket = state;
        }
      }
    }
  }

  if (Object.keys(payload).length > 0) {
    wsEvents.marketPrices(matchId, payload);
  }
}

async function ensureConnection() {
  if (connection) return connection;

  const { rpcUrl, wsUrl } = getHeliusEndpoints();

  connection = new Connection(rpcUrl, {
    wsEndpoint: wsUrl,
    commitment: COMMITMENT,
  });

  logger.info("Price stream connection created", { wsUrl });
  startPingLoop();

  return connection;
}

function startPingLoop() {
  if (pingTimer || !connection) return;

  // web3.js manages the websocket internally, so we cannot directly call ws.ping().
  // To avoid idle periods, we do a very cheap periodic RPC call.
  // Helius recommends health checks / keepalive because websocket connections can go idle.
  pingTimer = setInterval(async () => {
    try {
      if (!connection) return;
      await connection.getSlot(COMMITMENT);
    } catch (error) {
      logger.warn("Price stream health check failed", { error: error?.message });
    }
  }, 60_000);
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

async function subscribeToMarket(market) {
  if (accountSubs.has(market.marketPda)) return;

  const conn = await ensureConnection();
  const pubkey = new PublicKey(market.marketPda);

  marketCache.set(market.marketPda, {
    id: market.id,
    matchId: market.matchId,
    marketType: market.marketType,
    marketIndex: market.marketIndex,
    targetRound: market.targetRound,
  });

  const subId = conn.onAccountChange(
    pubkey,
    async (accountInfo) => {
      try {
        const cached = marketCache.get(market.marketPda);
        if (!cached) return;

        const decodedMarket = decodeMarketAccount(accountInfo);
        const marketData = formatMarketData(cached, decodedMarket);
        latestMarketStates.set(market.marketPda, marketData);

        broadcastCombinedPrices(cached.matchId);
      } catch (error) {
        logger.error("Failed to process market account change", {
          marketPda: market.marketPda,
          error: error?.message,
        });
      }
    },
    COMMITMENT,
  );

  accountSubs.set(market.marketPda, subId);
  logger.info("Subscribed to market account", {
    marketId: market.id,
    marketPda: market.marketPda,
    subId,
  });

  // Fetch initial state immediately
  try {
    const initialInfo = await conn.getAccountInfo(pubkey, COMMITMENT);
    if (initialInfo) {
      const cached = marketCache.get(market.marketPda);
      if (cached) {
        const decodedMarket = decodeMarketAccount(initialInfo);
        const marketData = formatMarketData(cached, decodedMarket);
        latestMarketStates.set(market.marketPda, marketData);
        broadcastCombinedPrices(cached.matchId);
      }
    }
  } catch (error) {
    logger.warn("Failed to fetch initial market state", {
      marketPda: market.marketPda,
      error: error?.message,
    });
  }
}

async function unsubscribeMarket(marketPda) {
  if (!connection) return;

  const subId = accountSubs.get(marketPda);
  if (subId == null) return;

  try {
    await connection.removeAccountChangeListener(subId);
    logger.info("Unsubscribed from market account", { marketPda, subId });
  } catch (error) {
    logger.warn("Failed to unsubscribe market account", {
      marketPda,
      subId,
      error: error?.message,
    });
  } finally {
    accountSubs.delete(marketPda);
    marketCache.delete(marketPda);
    latestMarketStates.delete(marketPda);
  }
}

async function syncActiveMarketSubscriptions() {
  try {
    const activeMatch = await prisma.match.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });

    if (!activeMatch) {
      const subscribedPdAs = [...accountSubs.keys()];
      await Promise.all(subscribedPdAs.map(unsubscribeMarket));
      return;
    }

    const [mainMarket, roundMarket] = await Promise.all([
      prisma.market.findFirst({
        where: {
          matchId: activeMatch.id,
          marketType: "MAIN",
        },
      }),
      prisma.market.findFirst({
        where: {
          matchId: activeMatch.id,
          marketType: "MID_GAME",
          targetRound: activeMatch.roundNumber,
        },
      }),
    ]);

    const wantedMarkets = [mainMarket, roundMarket].filter(Boolean);

    const wantedSet = new Set(wantedMarkets.map((m) => m.marketPda));
    const existingSet = new Set(accountSubs.keys());

    // unsubscribe stale
    const stale = [...existingSet].filter((pda) => !wantedSet.has(pda));
    await Promise.all(stale.map(unsubscribeMarket));

    // subscribe new
    const missing = wantedMarkets.filter((m) => !existingSet.has(m.marketPda));
    await Promise.all(missing.map(subscribeToMarket));

    if (stale.length > 0 || missing.length > 0) {
      logger.info("Market subscription sync complete", {
        activeMatchId: activeMatch.id,
        roundNumber: activeMatch.roundNumber,
        subscribedCount: accountSubs.size,
      });
    }
  } catch (error) {
    logger.error("Failed to sync active market subscriptions", {
      error: error?.message,
    });
  }
}

async function teardownConnectionIfIdle() {
  if (!connection) return;
  if (accountSubs.size > 0) return;

  stopPingLoop();
  connection = null;
  logger.info("Price stream connection released");
}

export async function startPriceStream(refreshMs = 2000) {
  if (refreshTimer) return;

  await ensureConnection();
  await syncActiveMarketSubscriptions();

  // We still need a lightweight app-level sync loop because the "current round market"
  // changes as your game advances, and account subscriptions themselves do not know that.
  refreshTimer = setInterval(async () => {
    await syncActiveMarketSubscriptions();
  }, refreshMs);

  logger.info("Price stream started", { refreshMs });
}

export async function stopPriceStream() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const subscribedPdAs = [...accountSubs.keys()];
  await Promise.all(subscribedPdAs.map(unsubscribeMarket));

  await teardownConnectionIfIdle();

  logger.info("Price stream stopped");
}
