import dotenv from "dotenv";
import { z } from "zod";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env"), override: true });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(8080),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  SESSION_COOKIE_NAME: z.string().default("autobattle_session"),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  SESSION_COOKIE_SECURE: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true"),

  API_WORKERS: z.coerce.number().int().positive().default(1),

  // ── Solana & Web3 ──
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  CRANK_PRIVATE_KEY: z.string().min(1, "CRANK_PRIVATE_KEY is required"),
  AUTO_TOKEN_ADDRESS: z.string().min(32).optional(),
  SWITCHBOARD_PROGRAM_ID: z
    .string()
    .default("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"),

  // ── Agent Wallets ──
  AGENT_RED_PRIVATE_KEY: z.string().min(1, "AGENT_RED_PRIVATE_KEY is required"),
  AGENT_BLUE_PRIVATE_KEY: z
    .string()
    .min(1, "AGENT_BLUE_PRIVATE_KEY is required"),

  // ── LLM API ──
  LLM_API_ENDPOINT: z.string().url("LLM_API_ENDPOINT must be a valid URL"),

  // ── Crank Engine ──
  CRANK_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  CRANK_ENABLED: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true")
    .default(false),
  MOCK_SOLANA: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true")
    .default(false),

  // ── Match Break ──
  PREPARATION_PHASE_SECONDS: z.coerce.number().int().positive().default(120),
  MATCHMAKING_PHASE_SECONDS: z.coerce.number().int().positive().default(180),

  // ── Telegram Notifications ──
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_IDS: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return [];
      return value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    }),

  // ── Admin API Key ──
  ADMIN_API_KEY: z.string().min(1).optional(),

  // ── Openfort ──
  OPENFORT_SECRET_KEY: z.string().min(1, "OPENFORT_SECRET_KEY is required"),
  OPENFORT_WALLET_SECRET: z
    .string()
    .min(1, "OPENFORT_WALLET_SECRET is required"),
  OPENFORT_PUBLISHABLE_KEY: z
    .string()
    .min(1, "OPENFORT_PUBLISHABLE_KEY is required"),
  OPENFORT_ENCRYPTION_SHARE: z
    .string()
    .min(1, "OPENFORT_ENCRYPTION_SHARE is required"),
  OPENFORT_PROJECT_KEY: z.string().min(1, "OPENFORT_PROJECT_KEY is required"),
  OPENFORT_POLICY_ID: z.string().min(1, "OPENFORT_POLICY_ID is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid server environment configuration:\n${formatted}`);
}

export const env = parsed.data;
