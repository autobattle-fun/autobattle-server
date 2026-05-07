import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "../db/prisma.js";
import { getMatchBreakCountdown } from "./game-state-store.js";

// ── Telegram Bot Notification Service ───────────────────────────────
//
// Sends notifications for all WebSocket game events and critical errors
// to a list of Telegram user/group IDs using the Telegram Bot API.
// Also handles incoming bot commands via long-polling.

const TELEGRAM_API = "https://api.telegram.org/bot";

/**
 * Get all notification targets (env chat IDs).
 */
function getAllChatIds() {
  return env.TELEGRAM_CHAT_IDS || [];
}

/**
 * Check if Telegram notifications are enabled.
 */
function isEnabled() {
  return Boolean(env.TELEGRAM_BOT_TOKEN) && getAllChatIds().length > 0;
}

// ── Core Send Function ──────────────────────────────────────────────

/**
 * Send a message to a specific Telegram chat ID.
 */
async function sendMessage(chatId, text, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  try {
    const response = await fetch(
      `${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...options,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.warn("Telegram sendMessage failed", {
        chatId,
        status: response.status,
        error: errorData.description,
      });
    }
  } catch (error) {
    logger.warn("Telegram send error", {
      chatId,
      error: error.message,
    });
  }
}

/**
 * Send a notification to ALL configured chat IDs.
 */
export async function sendNotification(message) {
  if (!isEnabled()) return;

  const chatIds = getAllChatIds();
  await Promise.allSettled(chatIds.map((id) => sendMessage(id, message)));
}

// ── Event Formatting ────────────────────────────────────────────────

const EVENT_EMOJI = {
  "match:created": "🎮",
  "round:started": "🔔",
  "cards:dealt": "🃏",
  "agent:decision": "🤖",
  "river:flowing": "🌊",
  "round:resolved": "⚔️",
  "tiebreaker:started": "⚡",
  "tiebreaker:resolved": "🎯",
  "match:ended": "🏆",
  "game:paused": "⏸️",
  "game:resumed": "▶️",
  "game:error": "🚨",
  "break:preparing": "⏳",
  "log:broadcast": "📝",
};

/**
 * Format and send a game event as a Telegram notification.
 */
export async function notifyEvent(eventType, data, matchId) {
  if (!isEnabled()) return;

  const emoji = EVENT_EMOJI[eventType] || "📡";
  const escapedMatchId = matchId ? escapeHTML(matchId) : null;
  let message = `${emoji} <b>${eventType.toUpperCase()}</b>\n`;

  if (escapedMatchId) {
    message += `Match: <code>${escapedMatchId}</code>\n`;
  }

  // Format event-specific data
  switch (eventType) {
    case "match:created": {
      const g = data.game || data;
      message += `Game #${escapeHTML(g.gameId)}\n`;
      message += `🔴 ${escapeHTML(g.red?.name || "Red")} (${escapeHTML(g.red?.llm || g.llmRed)})\n`;
      message += `🔵 ${escapeHTML(g.blue?.name || "Blue")} (${escapeHTML(g.blue?.llm || g.llmBlue)})`;
      break;
    }

    case "round:started":
      message += `Round ${data.roundNumber}`;
      break;

    case "agent:decision":
      if (data.playerStatus) {
        message += `Player Status: Red=${data.playerStatus.red}, Blue=${data.playerStatus.blue}`;
      }
      if (data.red) message += `\n❤️ Red: ${data.red.score} pts`;
      if (data.blue) message += `\n💙 Blue: ${data.blue.score} pts`;
      break;

    case "round:resolved":
      message += `Phase: ${data.phase}\n`;
      if (data.red) message += `❤️ Red: ${data.red.hp} HP (Score: ${data.red.score})\n`;
      if (data.blue) message += `💙 Blue: ${data.blue.hp} HP (Score: ${data.blue.score})`;
      break;

    case "match:ended":
      message += `🏆 <b>MATCH ENDED</b>\n`;
      message += `Game #${data.gameId}\n`;
      if (data.red) message += `🔴 ${data.red.name} (${data.red.hp} HP)\n`;
      if (data.blue) message += `🔵 ${data.blue.name} (${data.blue.hp} HP)`;
      break;

    case "game:paused":
      message += `⚠️ <b>MATCH PAUSED</b>\n`;
      message += `Reason: ${escapeHTML(data.reason)}\n`;
      if (data.error) message += `Error: <code>${escapeHTML(data.error)}</code>`;
      break;

    case "game:resumed":
      message += `✅ Match resumed`;
      break;

    case "break:preparing":
      message += `Next match at: ${data.nextMatchAt}`;
      break;

    case "log:broadcast":
      message += `[${escapeHTML(data.role || "System")}] ${escapeHTML(data.log || data.message)}`;
      break;

    default:
      // Generic formatting for other events
      message += formatDataCompact(data);
      break;
  }

  await sendNotification(message);
}

/**
 * Send a critical error alert via Telegram.
 */
export async function notifyError(context, error) {
  if (!isEnabled()) return;

  const safeContext = escapeHTML(context);
  const safeError = escapeHTML(error.message || String(error));
  const safeStack = escapeHTML((error.stack || "").slice(0, 500));

  const message =
    `🚨 <b>CRITICAL ERROR</b>\n\n` +
    `Context: ${safeContext}\n` +
    `Error: <code>${safeError}</code>\n` +
    `Stack: <code>${safeStack}</code>\n\n` +
    `⏸️ Match has been PAUSED. Use /resume to continue.`;

  await sendNotification(message);
}

// ── Bot Commands (Long-Polling) ─────────────────────────────────────

let pollingActive = false;
let pollingOffset = 0;

/**
 * Start the Telegram bot with long-polling for commands.
 */
export async function startTelegramBot() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.info("Telegram bot DISABLED (no TELEGRAM_BOT_TOKEN)");
    return;
  }

  // Set bot commands
  await setBotCommands();

  pollingActive = true;
  logger.info("Telegram bot started (long-polling)");

  // Non-blocking polling loop
  pollUpdates();
}

/**
 * Stop the Telegram bot polling.
 */
export function stopTelegramBot() {
  pollingActive = false;
  logger.info("Telegram bot stopped");
}

/**
 * Register bot commands with Telegram.
 */
async function setBotCommands() {
  try {
    await fetch(
      `${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "start", description: "Register for notifications" },
            { command: "status", description: "Get current game status" },
            { command: "pause", description: "Pause the active match" },
            { command: "resume", description: "Resume a paused match" },
            { command: "countdown", description: "Get break countdown" },
            { command: "ping", description: "Simulate a ping/pong response" },
            { command: "help", description: "Show available commands" },
          ],
        }),
      },
    );
  } catch (error) {
    logger.warn("Failed to set bot commands", { error: error.message });
  }
}

/**
 * Long-polling loop for receiving bot updates.
 */
async function pollUpdates() {
  while (pollingActive) {
    try {
      const response = await fetch(
        `${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${pollingOffset}&timeout=30`,
      );

      if (!response.ok) {
        logger.warn("Telegram polling error", { status: response.status });
        await sleep(5000);
        continue;
      }

      const data = await response.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          pollingOffset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (error) {
      logger.warn("Telegram polling error", { error: error.message });
      await sleep(5000);
    }
  }
}

/**
 * Handle an incoming Telegram update (message / command).
 */
async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const userId = String(message.from?.id);

  const allowedIds = getAllChatIds();
  if (!allowedIds.includes(userId) && !allowedIds.includes(String(chatId))) {
    await sendMessage(chatId, "I do not know you");
    return;
  }

  if (!text.startsWith("/")) return;

  const command = text.split("@")[0].split(" ")[0].toLowerCase();

  try {
    switch (command) {
      case "/start":
        await handleStartCommand(chatId, message.from);
        break;
      case "/status":
        await handleStatusCommand(chatId);
        break;
      case "/pause":
        await handlePauseCommand(chatId);
        break;
      case "/resume":
        await handleResumeCommand(chatId);
        break;
      case "/countdown":
        await handleCountdownCommand(chatId);
        break;
      case "/ping":
        await handlePingCommand(chatId);
        break;
      case "/help":
        await handleHelpCommand(chatId);
        break;
      default:
        await sendMessage(chatId, "❓ Unknown command. Use /help to see available commands.");
    }
  } catch (error) {
    logger.error("Telegram command handler error", {
      command,
      error: error.message,
    });
    await sendMessage(chatId, `❌ Error: ${error.message}`);
  }
}

// ── Command Handlers ────────────────────────────────────────────────

async function handleStartCommand(chatId, from) {
  const name = escapeHTML(from?.first_name || "User");
  await sendMessage(
    chatId,
    `👋 Welcome, ${name}!\n\n` +
    `You are now registered for AutoBattle notifications.\n` +
    `Your Chat ID: <code>${chatId}</code>\n\n` +
    `Add this ID to TELEGRAM_CHAT_IDS in your .env to receive all game events.\n\n` +
    `Use /help to see available commands.`,
  );
}

async function handleStatusCommand(chatId) {
  const activeMatch = await prisma.match.findFirst({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!activeMatch) {
    const countdown = await getMatchBreakCountdown();
    if (countdown.isBreak) {
      await sendMessage(
        chatId,
        `⏳ <b>No active match</b>\n\n` +
        `Next match starts in: <b>${countdown.remainingSeconds}s</b>\n` +
        `Start time: ${countdown.nextStartAt}`,
      );
    } else {
      await sendMessage(chatId, "💤 No active match and no break countdown.");
    }
    return;
  }

  const statusEmoji = activeMatch.status === "PAUSED" ? "⏸️" : "🎮";

  await sendMessage(
    chatId,
    `${statusEmoji} <b>Match #${escapeHTML(activeMatch.gameId)}</b> — ${escapeHTML(activeMatch.status)}\n\n` +
    `Round: ${activeMatch.roundNumber}\n` +
    `❤️ Red: ${activeMatch.redHp} HP | 💙 Blue: ${activeMatch.blueHp} HP\n` +
    `🔴 ${escapeHTML(activeMatch.llmRed)}\n🔵 ${escapeHTML(activeMatch.llmBlue)}`,
  );
}

async function handlePauseCommand(chatId) {
  const activeMatch = await prisma.match.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  if (!activeMatch) {
    await sendMessage(chatId, "❌ No active match to pause.");
    return;
  }

  await prisma.match.update({
    where: { id: activeMatch.id },
    data: { status: "PAUSED" },
  });

  await sendMessage(
    chatId,
    `⏸️ <b>Match #${activeMatch.gameId} PAUSED</b>\n` +
    `Use /resume to continue.`,
  );
}

async function handleResumeCommand(chatId) {
  const pausedMatch = await prisma.match.findFirst({
    where: { status: "PAUSED" },
    orderBy: { createdAt: "desc" },
  });

  if (!pausedMatch) {
    await sendMessage(chatId, "❌ No paused match to resume.");
    return;
  }

  await prisma.match.update({
    where: { id: pausedMatch.id },
    data: { status: "ACTIVE" },
  });

  await sendMessage(
    chatId,
    `▶️ <b>Match #${pausedMatch.gameId} RESUMED</b>\n` +
    `The crank will pick it up on the next cycle.`,
  );
}

async function handleCountdownCommand(chatId) {
  const countdown = await getMatchBreakCountdown();

  if (!countdown.isBreak) {
    await sendMessage(chatId, "⏱️ No break countdown active.");
    return;
  }

  await sendMessage(
    chatId,
    `⏳ <b>Break Countdown</b>\n\n` +
    `Remaining: <b>${countdown.remainingSeconds}s</b>\n` +
    `Next match at: ${countdown.nextStartAt}`,
  );
}

async function handlePingCommand(chatId) {
  // Simulates a ping response with dummy data
  await sendMessage(
    chatId,
    `🏓 <b>PONG (Simulated)</b>\n\n` +
    `Latency: <b>42ms</b>\n` +
    `Match: <code>dummy-match-id-123</code>\n` +
    `Status: <b>ACTIVE</b>\n` +
    `Round: 1\n` +
    `❤️ Red HP: 80 | 💙 Blue HP: 100\n` +
    `Server Time: ${new Date().toISOString()}`
  );
}

async function handleHelpCommand(chatId) {
  await sendMessage(
    chatId,
    `🤖 <b>AutoBattle Bot Commands</b>\n\n` +
    `/start — Register for notifications\n` +
    `/status — Current game status\n` +
    `/pause — Pause the active match\n` +
    `/resume — Resume a paused match\n` +
    `/countdown — Break countdown timer\n` +
    `/ping — Simulate a ping/pong response\n` +
    `/help — Show this message`,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDataCompact(data) {
  if (!data || typeof data !== "object") return escapeHTML(String(data));

  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      const val = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
      return `${escapeHTML(k)}: ${escapeHTML(val)}`;
    })
    .join("\n");
}

/**
 * Escapes HTML special characters for Telegram HTML parse_mode.
 */
function escapeHTML(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>]/g, (tag) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  }[tag] || tag));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
