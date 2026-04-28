import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "../db/prisma.js";
import { getGameState, getMatchBreakCountdown } from "./game-state-store.js";
import { notifyEvent } from "./telegram.js";

// ── WebSocket Manager ───────────────────────────────────────────────
//
// Provides real-time game updates to connected frontend clients.
// Clients can subscribe to specific matches or receive all events.

let io = null;

/**
 * Initialize the WebSocket server on top of an existing HTTP server.
 */
export function initWebSocket(httpServer) {
  io = new SocketIOServer(httpServer, {
    path: "/ws",
    cors: {
      origin: env.CLIENT_ORIGIN,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
    },
  });

  io.on("connection", (socket) => {
    const clientIp =
      socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
    logger.info("WebSocket client connected", { clientIp });

    // Join the global room by default to receive broadcasts not tied to a match
    socket.join("global");

    // Clients can subscribe to a specific match by sending:
    // e.g. socket.emit("subscribe", { matchId: "cuid..." })
    socket.subscribedMatchId = null;

    socket.on("subscribe", (message) => {
      try {
        if (message && message.matchId) {
          if (socket.subscribedMatchId) {
            socket.leave(socket.subscribedMatchId);
          }
          socket.leave("global");
          socket.join(message.matchId);
          socket.subscribedMatchId = message.matchId;
          
          socket.emit("subscribed", { matchId: message.matchId });
          logger.info("Client subscribed to match", {
            matchId: message.matchId,
          });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on("ping", async (message) => {
      try {
        await handlePing(socket, message || {});
      } catch {
        // Ignore ping errors
      }
    });

    socket.on("disconnect", () => {
      logger.info("WebSocket client disconnected", { clientIp });
    });

    socket.on("error", (error) => {
      logger.error("WebSocket client error", { error: error.message });
    });

    // Send a welcome message
    socket.emit("connected", {
      message: "AutoBattle WebSocket connected",
    });
  });

  logger.info("WebSocket server initialized", { path: "/ws" });
}

// ── Ping-Pong Handler ───────────────────────────────────────────────

/**
 * Handle a client ping and respond with game state + latency.
 *
 * Client sends:  socket.emit("ping", { "timestamp": 1714000000000 })
 * Server sends:  socket.emit("pong", { "latency": 42, "gameState": {...}, "countdown": {...}, "serverTimestamp": ... })
 */
async function handlePing(socket, message) {
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

  socket.emit("pong", {
    latency,
    gameState,
    countdown,
    serverTimestamp,
  });
}

// ── Event Broadcasting ──────────────────────────────────────────────

/**
 * Broadcast a game event to all connected clients.
 * Also forwards the event as a Telegram notification.
 */
export function broadcast(eventType, payload, matchId) {
  if (!io) return;

  const dataEnvelope = {
    type: eventType,
    matchId: matchId || null,
    data: payload,
    timestamp: new Date().toISOString(),
  };

  if (matchId) {
    // Send to specific match room and the global room
    io.to(matchId).to("global").emit(eventType, dataEnvelope);
  } else {
    // Send to everyone 
    io.emit(eventType, dataEnvelope);
  }

  logger.info("WebSocket broadcast", { eventType, matchId });

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
    if (!io) return;
    io.emit("pong", { type: "pong", ...data });
  },
};

