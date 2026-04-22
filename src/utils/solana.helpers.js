import { PublicKey } from "@solana/web3.js";
import {
  GAME_ENGINE_PROGRAM_ID,
  PRED_MARKET_PROGRAM_ID,
} from "../services/solana.service.js";

// ── Buffer Helpers ──────────────────────────────────────────────────

/**
 * Convert a numeric game ID into an 8-byte little-endian buffer
 * suitable for PDA derivation seeds.
 */
export function gameIdBuf(id) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(id));
  return b;
}

/**
 * Wrap a single u8 value into a 1-byte buffer.
 */
export function u8Buf(v) {
  return Buffer.from([v]);
}

// ── PDA Derivation ──────────────────────────────────────────────────

export function deriveRegistryPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    GAME_ENGINE_PROGRAM_ID,
  );
}

export function deriveGamePda(gameId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("game"), gameIdBuf(gameId)],
    GAME_ENGINE_PROGRAM_ID,
  );
}

export function deriveVrfRequestPda(gameId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vrf_request"), gameIdBuf(gameId)],
    GAME_ENGINE_PROGRAM_ID,
  );
}

export function deriveMarketPda(gameId, marketIndex = 0) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), gameIdBuf(gameId), u8Buf(marketIndex)],
    PRED_MARKET_PROGRAM_ID,
  );
}

export function deriveVaultPda(gameId, marketIndex = 0) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), gameIdBuf(gameId), u8Buf(marketIndex)],
    PRED_MARKET_PROGRAM_ID,
  );
}

export function derivePositionPda(marketPda, userPubkey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      new PublicKey(marketPda).toBuffer(),
      new PublicKey(userPubkey).toBuffer(),
    ],
    PRED_MARKET_PROGRAM_ID,
  );
}

// ── Anchor Enum Parsers ─────────────────────────────────────────────

/**
 * Parse an Anchor enum variant (e.g. { awaitingInitialDeal: {} })
 * into a normalised uppercase string: "AWAITING_INITIAL_DEAL".
 */
export function parseGamePhase(phaseObj) {
  if (!phaseObj) return "UNKNOWN";
  const key = Object.keys(phaseObj)[0];
  return camelToScreamingSnake(key);
}

/**
 * Parse Color enum ({ red: {} } | { blue: {} }) → "RED" | "BLUE".
 */
export function parseColor(colorObj) {
  if (!colorObj) return null;
  return Object.keys(colorObj)[0].toUpperCase();
}

/**
 * Parse Outcome enum ({ yes: {} } | { no: {} }) → "YES" | "NO".
 */
export function parseOutcome(outcomeObj) {
  if (!outcomeObj) return null;
  return Object.keys(outcomeObj)[0].toUpperCase();
}

/**
 * Convert camelCase string to SCREAMING_SNAKE_CASE.
 * e.g. "awaitingInitialDeal" → "AWAITING_INITIAL_DEAL"
 */
function camelToScreamingSnake(str) {
  return str.replace(/([A-Z])/g, "_$1").toUpperCase();
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate that a string is a valid Solana base58 public key.
 * Returns the PublicKey instance or throws.
 */
export function toPublicKey(address) {
  try {
    return new PublicKey(address);
  } catch {
    const error = new Error(`Invalid Solana address: ${address}`);
    error.statusCode = 400;
    throw error;
  }
}
