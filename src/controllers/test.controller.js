import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  solanaService,
  GAME_ENGINE_PROGRAM_ID,
  PRED_MARKET_PROGRAM_ID,
} from "../services/solana.service.js";
import { prisma } from "../db/prisma.js";

// Optional: Put your $AUTO token mint address in your .env
// For testing, we can default to a placeholder if it's missing
const AUTO_MINT_ADDRESS = process.env.AUTO_MINT_ADDRESS
  ? new PublicKey(process.env.AUTO_MINT_ADDRESS)
  : solanaService.crankKeypair.publicKey; // Warning: Use actual mint in prod!

// Helpers for PDA derivation
const gameIdBuf = (id) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(id));
  return b;
};
const u8Buf = (v) => Buffer.from([v]);

export async function createMarket(req, res) {
  try {
    const crank = solanaService.crankKeypair.publicKey;

    // 1. Fetch Registry & Calculate Next Game ID
    const [registryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("registry")],
      GAME_ENGINE_PROGRAM_ID,
    );

    let nextGameId = 1;
    try {
      const reg =
        await solanaService.gameEngine.account.registry.fetch(registryPda);
      nextGameId = reg.gameCount.toNumber() + 1;
    } catch (error) {
      console.log("Registry not found. You might need to initialize it first!");
      return res
        .status(400)
        .json({ error: "Registry not initialized on-chain." });
    }

    // 2. Derive all required PDAs
    const [gamePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), gameIdBuf(nextGameId)],
      GAME_ENGINE_PROGRAM_ID,
    );
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), gameIdBuf(nextGameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), gameIdBuf(nextGameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );

    console.log(`[BLOCKCHAIN] Initializing Match #${nextGameId}...`);

    // For testing, we are using the Crank as both Agent Red and Agent Blue.
    // In production, these would be the actual AI Agent pubkeys.
    const agentRed = crank;
    const agentBlue = crank;

    // 3. Execute Blockchain Transactions
    // Init Game
    await solanaService.gameEngine.methods
      .initGame(agentRed, agentBlue)
      .accounts({
        registry: registryPda,
        gameState: gamePda,
        crank: crank,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Set expiry 100 years in the future (Permanent Polymarket Mode)
    const closesAtUnix = Math.floor(Date.now() / 1000) + 3153600000;

    await solanaService.predMarket.methods
      .createMarket(
        new BN(nextGameId),
        0,
        `Will Red Win Match #${nextGameId}?`,
        new BN(closesAtUnix),
      )
      .accounts({
        market: marketPda,
        vault: vaultPda,
        autoMint: AUTO_MINT_ADDRESS,
        authority: crank,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .rpc();

    console.log(`[DATABASE] Saving Match #${nextGameId} to Prisma...`);

    // 4. Save to Database
    // We use a Prisma Transaction to ensure both records are created together
    const matchRecord = await prisma.$transaction(async (tx) => {
      const match = await tx.match.create({
        data: {
          gameId: nextGameId,
          gamePda: gamePda.toBase58(),
          agentRed: agentRed.toBase58(),
          agentBlue: agentBlue.toBase58(),
          status: "PENDING",
        },
      });

      const market = await tx.market.create({
        data: {
          slug: `match-${nextGameId}-main`,
          title: `Match #${nextGameId}: Red vs Blue`,
          description: "Main prediction market for the overall match winner.",
          matchId: match.id,
          marketPda: marketPda.toBase58(),
          vaultPda: vaultPda.toBase58(),
          marketIndex: 0,
          marketType: "MAIN",
          status: "OPEN",
          closesAt: new Date(closesAtUnix * 1000), // Convert Unix back to JS Date
        },
      });

      return { match, market };
    });

    return res.status(200).json({
      success: true,
      message: `Match #${nextGameId} created successfully.`,
      data: matchRecord,
    });
  } catch (error) {
    console.error("Error creating market:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
