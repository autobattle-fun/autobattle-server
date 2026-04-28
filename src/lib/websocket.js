import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { prisma } from "../db/prisma.js";
import { getGameState, getMatchBreakCountdown } from "./game-state-store.js";
import { notifyEvent } from "./telegram.js";

// ── WebSocket Manager ───────────────────────────────────────────────
//
// Provides real-time game updates to connected frontend clients.
// Clients can subscribe to specific matches or receive all events.

let wss = null;

/**
 * Initialize the WebSocket server on top of an existing HTTP server.
 */
export function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const clientIp =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    logger.info("WebSocket client connected", { clientIp });

    // Clients can subscribe to a specific match by sending:
    // { "type": "subscribe", "matchId": "cuid..." }
    ws.subscribedMatchId = null;

    ws.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        if (message.type === "subscribe" && message.matchId) {
          ws.subscribedMatchId = message.matchId;
          ws.send(
            JSON.stringify({
              type: "subscribed",
              matchId: message.matchId,
            }),
          );
          logger.info("Client subscribed to match", {
            matchId: message.matchId,
          });
        } else if (message.type === "ping") {
          await handlePing(ws, message);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected", { clientIp });
    });

    ws.on("error", (error) => {
      logger.error("WebSocket client error", { error: error.message });
    });

    // Send a welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "AutoBattle WebSocket connected",
      }),
    );
  });

  logger.info("WebSocket server initialized", { path: "/ws" });
}

// ── Ping-Pong Handler ───────────────────────────────────────────────

/**
 * Handle a client ping and respond with game state + latency.
 *
 * Client sends:  { "type": "ping", "timestamp": 1714000000000 }
 * Server sends:  { "type": "pong", "latency": 42, "gameState": {...}, "countdown": {...}, "serverTimestamp": ... }
 */
async function handlePing(ws, message) {
  const serverTimestamp = Date.now();
  const clientTimestamp = message.timestamp || serverTimestamp;
  const latency = Math.max(0, serverTimestamp - clientTimestamp);

  let gameState = null;
  let countdown = null;

  try {
    // Check for active or paused match
    const activeMatch = await prisma.match.findFirst({
      where: { status: { in: ["ACTIVE", "PAUSED", "PENDING"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        gameId: true,
        matchUuid: true,
        status: true,
        roundNumber: true,
        redHp: true,
        blueHp: true,
        llmRed: true,
        llmBlue: true,
        agentRed: true,
        agentBlue: true,
        createdAt: true,
      },
    });

    if (activeMatch) {
      // Get detailed game state from Redis
      const redisState = await getGameState(activeMatch.gameId);

      gameState = {
        matchId: activeMatch.id,
        gameId: activeMatch.gameId,
        status: activeMatch.status,
        roundNumber: activeMatch.roundNumber,
        redHp: activeMatch.redHp,
        blueHp: activeMatch.blueHp,
        llmRed: activeMatch.llmRed,
        llmBlue: activeMatch.llmBlue,
        phase: redisState?.phase || activeMatch.status,
        red: redisState?.red || null,
        blue: redisState?.blue || null,
      };
    } else {
      // No active match — check for break countdown
      countdown = await getMatchBreakCountdown();
    }
  } catch (error) {
    logger.warn("Error building pong response", { error: error.message });
  }

  ws.send(
    JSON.stringify({
      type: "pong",
      latency,
      gameState,
      countdown,
      serverTimestamp,
    }),
  );
}

// ── Event Broadcasting ──────────────────────────────────────────────

/**
 * Broadcast a game event to all connected clients.
 * Also forwards the event as a Telegram notification.
 */
export function broadcast(eventType, payload, matchId) {
  if (!wss) return;

  const message = JSON.stringify({
    type: eventType,
    matchId: matchId || null,
    data: payload,
    timestamp: new Date().toISOString(),
  });

  let sent = 0;

  for (const client of wss.clients) {
    if (client.readyState !== 1) continue; // WebSocket.OPEN = 1

    const isSubscribed =
      !matchId ||
      !client.subscribedMatchId ||
      client.subscribedMatchId === matchId;

    if (isSubscribed) {
      client.send(message);
      sent++;
    }
  }

  if (sent > 0) {
    logger.info("WebSocket broadcast", { eventType, matchId, clients: sent });
  }

  // Forward to Telegram (fire-and-forget, never block the broadcast)
  notifyEvent(eventType, payload, matchId).catch(() => { });
}

// ── Typed Event Helpers ─────────────────────────────────────────────

export const wsEvents = {
  matchCreated(match) {
    broadcast(
      "match:created",
      {
        matchId: match.id,
        gameId: match.gameId,
        matchUuid: match.matchUuid,
        llmRed: match.llmRed,
        llmBlue: match.llmBlue,
        agentRed: match.agentRed,
        agentBlue: match.agentBlue,
      },
      match.id,
    );
  },

  roundStarted(matchId, { roundNumber, gameId, redHp, blueHp }) {
    broadcast(
      "round:started",
      { roundNumber, gameId, redHp, blueHp },
      matchId,
    );
  },

  cardsDealt(matchId, { redScore, blueScore, redCard, blueCard }) {
    broadcast(
      "cards:dealt",
      { redScore, blueScore, redCard, blueCard },
      matchId,
    );
  },

  agentDecision(matchId, { player, action, reason, model, scoreBefore, scoreAfter, cardDealt }) {
    broadcast(
      "agent:decision",
      { player, action, reason, model, scoreBefore, scoreAfter, cardDealt },
      matchId,
    );
  },

  riverRevealed(matchId, { redScore, blueScore, redCard, blueCard }) {
    broadcast(
      "river:revealed",
      { redScore, blueScore, redCard, blueCard },
      matchId,
    );
  },

  roundResolved(matchId, { roundNumber, redHp, blueHp, redScore, blueScore, damageDealt, roundWinner }) {
    broadcast(
      "round:resolved",
      { roundNumber, redHp, blueHp, redScore, blueScore, damageDealt, roundWinner },
      matchId,
    );
  },

  tiebreakerStarted(matchId, { roundNumber, redScore, blueScore }) {
    broadcast(
      "tiebreaker:started",
      { roundNumber, redScore, blueScore },
      matchId,
    );
  },

  tiebreakerResolved(matchId, { redScore, blueScore, redCard, blueCard }) {
    broadcast(
      "tiebreaker:resolved",
      { redScore, blueScore, redCard, blueCard },
      matchId,
    );
  },

  hpUpdated(matchId, { redHp, blueHp }) {
    broadcast("hp:updated", { redHp, blueHp }, matchId);
  },

  gameStats(matchId, stats) {
    broadcast("game:stats", stats, matchId);
  },

  matchEnded(matchId, { winner, gameId, totalRounds, llmRed, llmBlue }) {
    broadcast(
      "match:ended",
      { winner, gameId, totalRounds, llmRed, llmBlue },
      matchId,
    );
  },

  gamePaused(matchId, { reason, error }) {
    broadcast(
      "game:paused",
      { matchId, reason, error },
      matchId,
    );
  },

  gameResumed(matchId) {
    broadcast(
      "game:resumed",
      { matchId },
      matchId,
    );
  },

  breakCountdown({ remainingSeconds, nextStartAt }) {
    broadcast("break:countdown", { remainingSeconds, nextStartAt });
  },

  breakPreparing({ nextMatchAt }) {
    broadcast("break:preparing", { nextMatchAt });
  },

  marketPrices(marketId, prices) {
    broadcast("market:prices", prices, marketId);
  },

  logBroadcast(message, level = "info") {
    broadcast("log:broadcast", { message, level });
  },

  pong(data) {
    if (!wss) return;
    const message = JSON.stringify({ type: "pong", ...data });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(message);
    }
  },
};

