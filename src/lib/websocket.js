import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "../db/prisma.js";
import { getGameState, getMatchBreakCountdown } from "./game-state-store.js";
import {
  addRoundSystemLog,
  getRoundSystemLogs,
} from "./system-log-state-store.js";
import { notifyEvent } from "./telegram.js";
import { redis } from "../db/redis.js";

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
  let logs = [];
  let market = null;

  try {
    // Check for active or paused match
    let activeMatch = null;
    const cachedMatch = await redis.get("autobattle:ws:active_match");

    if (cachedMatch) {
      activeMatch = JSON.parse(cachedMatch);
    } else {
      activeMatch = await prisma.match.findFirst({
        where: {
          status: { in: ["ACTIVE", "PAUSED", "PENDING", "MATCHMAKING"] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          gameId: true,
          matchUuid: true,
          status: true,
          roundNumber: true,
          redHp: true,
          blueHp: true,
          redName: true,
          blueName: true,
          llmRed: true,
          llmBlue: true,
          agentRed: true,
          agentBlue: true,
          createdAt: true,
        },
      });

      if (activeMatch) {
        await redis.setex(
          "autobattle:ws:active_match",
          2,
          JSON.stringify(activeMatch),
        );
      } else {
        await redis.setex(
          "autobattle:ws:active_match",
          2,
          JSON.stringify(null),
        );
      }
    }

    if (activeMatch) {
      // Get detailed game state from Redis
      logs = await getRoundSystemLogs(activeMatch.id);
      const redisState = await getGameState(activeMatch.gameId);

      const { getCurrentMarketPrices } = await import("./price-stream.js");
      const currentMarketPrices = getCurrentMarketPrices(activeMatch.id);
      market =
        Object.keys(currentMarketPrices).length > 0
          ? currentMarketPrices
          : null;

      const activePlayerColor = redisState?.activePlayer || "RED";
      const activePlayerName =
        activePlayerColor === "RED"
          ? activeMatch.redName
          : activeMatch.blueName;

      gameState = {
        gameId: activeMatch.gameId,
        matchId: activeMatch.id,
        gameStatus:
          activeMatch.status === "PAUSED" ? "ACTIVE" : activeMatch.status,
        serverStatus: activeMatch.status === "PAUSED" ? "PAUSED" : "ACTIVE",
        activePlayer: { color: activePlayerColor, name: activePlayerName },
        playerStatus: redisState?.playerStatus || {
          red: "WAITING",
          blue: "WAITING",
        },
        roundNumber: activeMatch.roundNumber,
        redHp: activeMatch.redHp,
        blueHp: activeMatch.blueHp,
        red: {
          hp: activeMatch.redHp,
          name: activeMatch.redName,
          llm: activeMatch.llmRed,
          score: redisState?.red?.score || 0,
          stayed: redisState?.red?.stayed || false,
          cards: redisState?.red?.cards || [],
        },
        blue: {
          hp: activeMatch.blueHp,
          name: activeMatch.blueName,
          llm: activeMatch.llmBlue,
          score: redisState?.blue?.score || 0,
          stayed: redisState?.blue?.stayed || false,
          cards: redisState?.blue?.cards || [],
        },
        river: { red: redisState?.riverRed, blue: redisState?.riverBlue },
        tiebreakerCards: redisState?.tiebreakerCards || [],
        cardHistory: {
          pastRounds: redisState?.pastRounds || [],
          currentRound: {
            redCards: redisState?.red?.cards || [],
            blueCards: redisState?.blue?.cards || [],
          },
        },
      };
    } else {
      // No active match — check for break countdown
      countdown = await getMatchBreakCountdown();
    }
  } catch (error) {
    logger.warn("Error building pong response", { error: error.message });
  }

  // socket.emit("pong", {
  //   latency,
  //   gameState,
  //   market,
  //   logs,
  //   countdown,
  //   serverTimestamp,
  // });

  // Test pong data
  socket.emit("pong", {
    latency,
    gameState: {
      gameId: 999,
      gameStatus: "ACTIVE",
      serverStatus: "ACTIVE",
      activePlayer: { color: "RED", name: "Donald Trump" },
      playerStatus: { red: "THINKING", blue: "WAITING" },
      phase: "RedTurn",
      roundNumber: 3,
      red: {
        hp: 9,
        score: 15,
        name: "Donald Trump",
        llm: "llama-3",
        cards: [
          { value: 7, label: "7" },
          { value: 8, label: "8" },
        ],
      },
      blue: {
        hp: 8,
        score: 12,
        name: "Joe Biden",
        llm: "mixtral",
        cards: [
          { value: 10, label: "10" },
          { value: 2, label: "2" },
        ],
      },
    },
    market: {
      mainMarket: {
        id: "cmot8795k0001ti8o4pxh8dp7",
        matchId: "cmot8795k0001ti8o4pxh8dp7",
        marketIndex: 0,
        targetRound: null,
        status: "OPEN",

        yesPrice: 0.5,
        noPrice: 0.5,
        totalVolumeRaw: 0,
      },
      roundMarket: {
        id: "cmot879e60002ti8ohs647mrv",
        matchId: "cmot879e60002ti8ohs647mrv",
        marketIndex: 1,
        targetRound: 1,
        status: "OPEN",

        yesPrice: 0.5,
        noPrice: 0.5,
        totalVolumeRaw: 0,
      },
    },
    logs: [
      {
        role: "red",
        message: "I Hit the card because I wanted to",
        timestamp: serverTimestamp,
      },
      {
        role: "blue",
        message: "I used 10. I think it will work. I believe this is the best.",
        timestamp: serverTimestamp - 1000,
      },
      {
        role: "system",
        message: "Smart Contract initialized. Awaiting Phase 1...",
        timestamp: serverTimestamp - 2000,
      },
    ],
    countdown: 228,
  });
}

// ── Event Broadcasting ──────────────────────────────────────────────

/**
 * Build the standard event envelope.
 */
function makeEnvelope(eventType, payload, matchId) {
  return {
    type: eventType,
    matchId: matchId || null,
    data: payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Emit an envelope to the appropriate socket.io rooms.
 */
function emitToRooms(eventType, envelope, matchId) {
  if (!io) return;

  if (matchId) {
    io.to(matchId).to("global").emit(eventType, envelope);
  } else {
    io.emit(eventType, envelope);
  }
}

/**
 * Broadcast a game event to all connected clients.
 * Also forwards the event as a Telegram notification.
 */
export function broadcast(eventType, payload, matchId) {
  if (!io) return;

  const envelope = makeEnvelope(eventType, payload, matchId);
  emitToRooms(eventType, envelope, matchId);

  logger.info("WebSocket broadcast", { eventType, matchId });

  // Forward to Telegram (fire-and-forget, never block the broadcast)
  notifyEvent(eventType, payload, matchId).catch(() => {});
}

/**
 * Broadcast a game event to WebSocket clients only (no Telegram).
 * Used for high-frequency events like market price updates.
 */
export function broadcastNoTelegram(eventType, payload, matchId) {
  if (!io) return;

  const envelope = makeEnvelope(eventType, payload, matchId);
  emitToRooms(eventType, envelope, matchId);

  logger.info("WebSocket broadcast (no-telegram)", { eventType, matchId });
}

// ── Typed Event Helpers ─────────────────────────────────────────────

export const wsEvents = {
  matchCreated(payload, matchId) {
    broadcast("match:created", payload, matchId);
  },

  roundStarted(payload, matchId) {
    broadcast("round:started", payload, matchId);
  },

  cardsDealt(payload, matchId) {
    broadcast("cards:dealt", payload, matchId);
  },

  agentDecision(payload, matchId) {
    broadcast("agent:decision", payload, matchId);
  },

  riverFlowing(payload, matchId) {
    broadcast("river:flowing", payload, matchId);
  },

  roundResolved(payload, matchId) {
    broadcast("round:resolved", payload, matchId);
  },

  tiebreakerStarted(payload, matchId) {
    broadcast("tiebreaker:started", payload, matchId);
  },

  tiebreakerResolved(payload, matchId) {
    broadcast("tiebreaker:resolved", payload, matchId);
  },

  matchEnded(payload, matchId) {
    broadcast("match:ended", payload, matchId);
  },

  gamePaused(payload, matchId) {
    broadcast("game:paused", payload, matchId);
  },

  gameResumed(payload, matchId) {
    broadcast("game:resumed", payload, matchId);
  },

  breakPreparing({ nextMatchAt }) {
    broadcast("break:preparing", { nextMatchAt });
  },

  marketPrices(matchId, prices) {
    broadcastNoTelegram("market:prices", prices, matchId);
  },

  logBroadcast(role, log, matchId) {
    broadcast(
      "log:broadcast",
      {
        role,
        log,
        timeStamp: Date.now(),
      },
      matchId,
    );

    addRoundSystemLog(matchId, role, log);
  },

  pong(data) {
    if (!io) return;
    io.emit("pong", { type: "pong", ...data });
  },
};
