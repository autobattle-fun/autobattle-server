import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

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
  PRIVY_APP_ID: z.string().min(1, "PRIVY_APP_ID is required"),
  PRIVY_APP_SECRET: z.string().min(1, "PRIVY_APP_SECRET is required"),
  PRIVY_JWT_VERIFICATION_KEY: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) {
        return undefined;
      }

      const normalized = value.trim();

      if (!normalized || /^your-/i.test(normalized)) {
        return undefined;
      }

      return normalized;
    }),
  API_WORKERS: z.coerce.number().int().positive().default(1),

  // ── Solana & Web3 ──
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  CRANK_PRIVATE_KEY: z.string().min(1, "CRANK_PRIVATE_KEY is required"),
  AUTO_MINT_ADDRESS: z.string().min(32).optional(),
  SWITCHBOARD_PROGRAM_ID: z
    .string()
    .default("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"),

  // ── Crank Engine ──
  CRANK_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  CRANK_ENABLED: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true")
    .default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid server environment configuration:\n${formatted}`);
}

export const env = parsed.data;
