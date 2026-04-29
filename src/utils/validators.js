import { z } from "zod";

// ── Reusable Primitives ─────────────────────────────────────────────

const solanaAddress = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Invalid Solana base58 address");

const predictionSide = z.enum(["YES", "NO"]);

// ── Request Schemas ─────────────────────────────────────────────────

export const advanceMatchSchema = z
  .object({
    rounds: z.coerce.number().int().min(1).max(10).default(1),
  })
  .strict();

export const recordPredictionSchema = z
  .object({
    side: predictionSide,
    amount: z.coerce.number().positive(),
    positionPda: solanaAddress,
    txSignature: z.string().min(64).max(128),
  })
  .strict();

export const listMatchesSchema = z
  .object({
    status: z.enum(["PENDING", "ACTIVE", "PAUSED", "RESOLVED"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const listMarketsSchema = z
  .object({
    status: z.enum(["OPEN", "CLOSED", "RESOLVED"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const listPredictionsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

// ── Validation Helper ───────────────────────────────────────────────

/**
 * Parse a zod schema against `data`. Throws a 400-status error
 * with formatted messages on failure.
 */
export function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    const error = new Error(formatted);
    error.statusCode = 400;
    throw error;
  }

  return result.data;
}
