import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  solanaService,
  GAME_ENGINE_PROGRAM_ID,
  PRED_MARKET_PROGRAM_ID,
} from "../services/solana.service.js";
import { prisma } from "../db/prisma.js";
import { ROLL_TYPE } from "../services/solana.service.js";
import { randomUUID } from "crypto";

// Optional: Put your $AUTO token mint address in your .env
// For testing, we can default to a placeholder if it's missing
const AUTO_MINT_ADDRESS = process.env.AUTO_TOKEN_ADDRESS
  ? new PublicKey(process.env.AUTO_TOKEN_ADDRESS)
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

    const agentRed = solanaService.agentRedKeypair.publicKey;
    const agentBlue = solanaService.agentBlueKeypair.publicKey;

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
          matchUuid: randomUUID(), // Generates a unique UUID for the chat
          llmRed: "meta-llama/llama-3-8b-instruct", // Placeholder OpenRouter model
          llmBlue: "mistralai/mixtral-8x7b-instruct", // Placeholder OpenRouter model
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

export async function dealCards(req, res) {
  const gameId = Number(req.params.gameId);
  try {
    console.log(`[BLOCKCHAIN] Requesting Initial Deal for Match #${gameId}...`);
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.INITIAL_DEAL);

    // Update DB status to ACTIVE
    await prisma.match.updateMany({
      where: { gameId: gameId },
      data: { status: "ACTIVE" },
    });

    return res
      .status(200)
      .json({ success: true, message: "Cards dealt.", txSig });
  } catch (error) {
    console.error("Deal error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 2. Agent Stay ---
export async function agentStay(req, res) {
  const gameId = Number(req.params.gameId);
  const player = req.params.player.toUpperCase(); // "RED" or "BLUE"

  try {
    console.log(`[BLOCKCHAIN] Agent ${player} staying in Match #${gameId}...`);
    const txSig = await solanaService.stay(gameId, player);
    return res
      .status(200)
      .json({ success: true, message: `${player} stayed.`, txSig });
  } catch (error) {
    console.error(`Stay error (${player}):`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function agentHit(req, res) {
  const gameId = Number(req.params.gameId);
  const player = req.params.player.toUpperCase(); // "RED" or "BLUE"

  if (isNaN(gameId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid gameId. Use /hit/<number>/<player>",
    });
  }

  if (player !== "RED" && player !== "BLUE") {
    return res.status(400).json({
      success: false,
      error: "Invalid player. Must be 'red' or 'blue'.",
    });
  }

  try {
    console.log(`[BLOCKCHAIN] Agent ${player} hitting in Match #${gameId}...`);

    // We pass the player color so the correct agent wallet signs the VRF request
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.HIT, player);

    return res.status(200).json({
      success: true,
      message: `${player} hit and received a new card.`,
      txSig,
    });
  } catch (error) {
    console.error(`Hit error (${player}):`, error);

    // Catch common contract errors gracefully
    if (error.message.includes("NotYourTurn")) {
      return res
        .status(400)
        .json({ success: false, error: "It is not this agent's turn." });
    }
    if (error.message.includes("Over21CannotHit")) {
      return res
        .status(400)
        .json({ success: false, error: "Agent is already busted (>= 21)." });
    }

    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 3. Final Reveal / River Card (VRF 2) ---
export async function revealRiver(req, res) {
  const gameId = Number(req.params.gameId);
  try {
    console.log(`[BLOCKCHAIN] Revealing River Cards for Match #${gameId}...`);
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.FINAL_REVEAL);
    return res
      .status(200)
      .json({ success: true, message: "River cards revealed.", txSig });
  } catch (error) {
    console.error("River reveal error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 4. Resolve Round (and check for Tiebreaker/Game Over) ---
export async function resolveRound(req, res) {
  const gameId = Number(req.params.gameId);
  try {
    console.log(`[BLOCKCHAIN] Resolving Round for Match #${gameId}...`);

    // Re-derive Market PDA to pass as a remaining account
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), gameIdBuf(gameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );

    let txSig;
    try {
      txSig = await solanaService.resolveRound(gameId, marketPda);
    } catch (e) {
      if (
        e.message.includes("MarketAlreadyResolved") ||
        e.message.includes("GameAlreadyEnded")
      ) {
        console.log("Match is already fully resolved.");
      } else {
        throw e; // Re-throw if it's a real error
      }
    }

    // Fetch the latest state to see what happened
    const gs = await solanaService.fetchGameState(gameId);
    const phaseKey = Object.keys(gs.phase)[0];

    // Sync HP to Database
    await prisma.match.updateMany({
      where: { gameId: gameId },
      data: { redHp: gs.p1Hp, blueHp: gs.p2Hp },
    });

    let message = `Round resolved. Red HP: ${gs.p1Hp} | Blue HP: ${gs.p2Hp}`;
    if (phaseKey === "ended") {
      message = `MATCH OVER! Winner: ${gs.p1Hp === 0 ? "BLUE" : "RED"}`;
      await prisma.match.updateMany({
        where: { gameId },
        data: { status: "RESOLVED" },
      });
    } else if (phaseKey === "awaitingTiebreakerVrf") {
      message = "TIE! Sudden death tiebreaker required.";
    }

    return res
      .status(200)
      .json({ success: true, message, phase: phaseKey, txSig });
  } catch (error) {
    console.error("Resolve error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 5. Tiebreaker (VRF 3) ---
export async function resolveTiebreaker(req, res) {
  const gameId = Number(req.params.gameId);
  try {
    console.log(`[BLOCKCHAIN] Running Tiebreaker for Match #${gameId}...`);
    const txSigVrf = await solanaService.vrfStep(gameId, ROLL_TYPE.TIEBREAKER);

    // Must immediately resolve round again after tiebreaker VRF
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), gameIdBuf(gameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );
    const txSigResolve = await solanaService.resolveRound(gameId, marketPda);

    const gs = await solanaService.fetchGameState(gameId);

    return res.status(200).json({
      success: true,
      message: "Tiebreaker resolved.",
      txSigVrf,
      txSigResolve,
      redHp: gs.p1Hp,
      blueHp: gs.p2Hp,
    });
  } catch (error) {
    console.error("Tiebreaker error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 6. Fetch Game Stats (On-Chain State) ---
export async function getGameStats(req, res) {
  const gameId = Number(req.params.gameId);

  if (isNaN(gameId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid gameId provided. Make sure to use /stats/<number>",
    });
  }

  try {
    console.log(`[BLOCKCHAIN] Fetching on-chain state for Match #${gameId}...`);

    // Fetch the raw state from the smart contract
    const gs = await solanaService.fetchGameState(gameId);

    // Anchor returns Enums as objects (e.g., { awaitingAction: {} })
    // We extract just the string key to make it readable for the frontend
    const currentPhase = Object.keys(gs.phase)[0];
    const activePlayer = Object.keys(gs.activePlayer)[0];
    const winner = gs.winner ? Object.keys(gs.winner)[0] : null;

    // Format the response, converting BigNumbers (BN) to standard JavaScript numbers
    const stats = {
      gameId: gs.gameId.toNumber(),
      phase: currentPhase,
      roundNumber: gs.roundNumber,
      activePlayer: activePlayer.toUpperCase(),
      winner: winner ? winner.toUpperCase() : null,
      agents: {
        red: gs.agentRed.toBase58(),
        blue: gs.agentBlue.toBase58(),
      },
      red: {
        hp: gs.p1Hp,
        score: gs.p1Score,
        aces: gs.p1Aces,
        hasStayed: gs.p1Stayed,
      },
      blue: {
        hp: gs.p2Hp,
        score: gs.p2Score,
        aces: gs.p2Aces,
        hasStayed: gs.p2Stayed,
      },
    };

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Fetch stats error:", error);

    // If the account doesn't exist yet, Anchor throws a specific error
    if (error.message.includes("Account does not exist")) {
      return res
        .status(404)
        .json({ success: false, error: "Match not found on-chain." });
    }

    return res.status(500).json({ success: false, error: error.message });
  }
}
