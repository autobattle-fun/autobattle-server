import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "websockets.log");

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log a WebSocket event to the log file.
 * 
 * @param {'SENT' | 'RECEIVED'} direction - Direction of the message
 * @param {string} eventType - The name of the event
 * @param {any} data - The message payload
 * @param {string} [matchId] - Optional match ID associated with the event
 */
export function logWsEvent(direction, eventType, data, matchId = null) {
  const timestamp = new Date().toISOString();
  
  // Format the log entry for readability
  const separator = "=".repeat(80);
  const header = `[${timestamp}] [${direction}] [${matchId || "GLOBAL"}] Event: ${eventType}`;
  const payload = JSON.stringify(data, null, 2);
  
  const logEntry = `${header}\n${payload}\n${separator}\n\n`;

  try {
    fs.appendFileSync(LOG_FILE, logEntry, "utf8");
  } catch (error) {
    console.error(`[ERROR] Failed to write to WebSocket log file: ${error.message}`);
  }
}
