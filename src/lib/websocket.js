import { WebSocketServer } from "ws";
import { logger } from "./logger.js";

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

    ws.on("message", (raw) => {
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

// ── Event Broadcasting ──────────────────────────────────────────────

/**
 * Broadcast a game event to all connected clients.
 * If `matchId` is provided, only clients subscribed to that match
 * (or unsubscribed clients receiving all events) will get it.
 *
 * @param {string} eventType - Event name (e.g. "match:created", "round:started")
 * @param {Object} payload - Event data
 * @param {string} [matchId] - Optional match ID for targeted delivery
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

    // Send to: unsubscribed clients (global) OR clients subscribed to this match
    const isSubscribed = !matchId || !client.subscribedMatchId || client.subscribedMatchId === matchId;

    if (isSubscribed) {
      client.send(message);
      sent++;
    }
  }

  if (sent > 0) {
    logger.info("WebSocket broadcast", { eventType, matchId, clients: sent });
  }
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

  roundStarted(matchId, roundNumber, gameId) {
    broadcast(
      "round:started",
      { roundNumber, gameId },
      matchId,
    );
  },

  cardsDealt(matchId, { p1Score, p2Score, isFinalReveal }) {
    broadcast(
      "cards:dealt",
      { redScore: p1Score, blueScore: p2Score, isFinalReveal },
      matchId,
    );
  },

  agentDecision(matchId, { player, action, model, score }) {
    broadcast(
      "agent:decision",
      { player, action, model, score },
      matchId,
    );
  },

  roundResolved(matchId, { roundNumber, redHp, blueHp, damageDealt }) {
    broadcast(
      "round:resolved",
      { roundNumber, redHp, blueHp, damageDealt },
      matchId,
    );
  },

  tiebreakerStarted(matchId, { roundNumber }) {
    broadcast(
      "tiebreaker:started",
      { roundNumber },
      matchId,
    );
  },

  hpUpdated(matchId, { redHp, blueHp }) {
    broadcast(
      "hp:updated",
      { redHp, blueHp },
      matchId,
    );
  },

  matchEnded(matchId, { winner, gameId, totalRounds }) {
    broadcast(
      "match:ended",
      { winner, gameId, totalRounds },
      matchId,
    );
  },
};
