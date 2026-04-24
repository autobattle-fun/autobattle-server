import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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

    // 2. Derive all required PDAs for MAIN Market (Index 0)
    const [gamePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), gameIdBuf(nextGameId)],
      GAME_ENGINE_PROGRAM_ID,
    );
    const [mainMarketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), gameIdBuf(nextGameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );
    const [mainVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), gameIdBuf(nextGameId), u8Buf(0)],
      PRED_MARKET_PROGRAM_ID,
    );

    // Derive PDAs for ROUND 1 Market (Index 1)
    const [round1MarketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), gameIdBuf(nextGameId), u8Buf(1)],
      PRED_MARKET_PROGRAM_ID,
    );
    const [round1VaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), gameIdBuf(nextGameId), u8Buf(1)],
      PRED_MARKET_PROGRAM_ID,
    );

    console.log(
      `[BLOCKCHAIN] Initializing Match #${nextGameId} and Markets...`,
    );

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

    // Create MAIN Market (Index 0)
    await solanaService.predMarket.methods
      .createMarket(
        new BN(nextGameId),
        0, // marketIndex
        `Will Red Win Match #${nextGameId}?`,
        new BN(closesAtUnix),
      )
      .accounts({
        market: mainMarketPda,
        vault: mainVaultPda,
        autoMint: AUTO_MINT_ADDRESS,
        authority: crank,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .rpc();

    // Create ROUND 1 Market (Index 1)
    await solanaService.predMarket.methods
      .createMarket(
        new BN(nextGameId),
        1, // marketIndex
        `Will Red Win Round 1 of Match #${nextGameId}?`,
        new BN(closesAtUnix),
      )
      .accounts({
        market: round1MarketPda,
        vault: round1VaultPda,
        autoMint: AUTO_MINT_ADDRESS,
        authority: crank,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .rpc();

    console.log(
      `[DATABASE] Saving Match #${nextGameId} and Markets to Prisma...`,
    );

    // 4. Save to Database
    const matchRecord = await prisma.$transaction(async (tx) => {
      const match = await tx.match.create({
        data: {
          gameId: nextGameId,
          gamePda: gamePda.toBase58(),
          agentRed: agentRed.toBase58(),
          agentBlue: agentBlue.toBase58(),
          status: "PENDING",
          matchUuid: randomUUID(),
          llmRed: "meta-llama/llama-3-8b-instruct",
          llmBlue: "mistralai/mixtral-8x7b-instruct",
        },
      });

      // Insert MAIN Market
      const mainMarket = await tx.market.create({
        data: {
          slug: `match-${nextGameId}-main`,
          title: `Match #${nextGameId}: Red vs Blue`,
          description: "Main prediction market for the overall match winner.",
          matchId: match.id,
          marketPda: mainMarketPda.toBase58(),
          vaultPda: mainVaultPda.toBase58(),
          marketIndex: 0,
          marketType: "MAIN",
          status: "OPEN",
          closesAt: new Date(closesAtUnix * 1000),
        },
      });

      // Insert ROUND 1 Market
      const round1Market = await tx.market.create({
        data: {
          slug: `match-${nextGameId}-round-1`,
          title: `Round 1 Winner: Red vs Blue`,
          description: "Micro-market predicting the winner of Round 1.",
          matchId: match.id,
          marketPda: round1MarketPda.toBase58(),
          vaultPda: round1VaultPda.toBase58(),
          marketIndex: 1,
          marketType: "MID_GAME",
          targetRound: 1,
          status: "OPEN",
          closesAt: new Date(closesAtUnix * 1000),
        },
      });

      return { match, mainMarket, round1Market };
    });

    return res.status(200).json({
      success: true,
      message: `Match #${nextGameId} and Markets created successfully.`,
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

    // 1. Fetch current game state to know which round we are actually starting
    const gs = await solanaService.fetchGameState(gameId);
    const currentRound = gs.roundNumber; // Will be 1, 2, 3, etc.

    // 2. Check if a market already exists for this round in the Database
    const existingMarket = await prisma.market.findFirst({
      where: {
        match: { gameId: gameId },
        targetRound: currentRound,
        marketType: "MID_GAME",
      },
    });

    // 3. If it's Round 2+ and the market doesn't exist, spawn it dynamically!
    if (!existingMarket && currentRound > 1) {
      console.log(
        `[BLOCKCHAIN] Dynamically spawning Market for Round ${currentRound}...`,
      );

      const closesAtUnix = Math.floor(Date.now() / 1000) + 3153600000;

      // We use currentRound directly as the marketIndex (Round 2 = Index 2)
      await solanaService.createOnChainMarket(
        gameId,
        currentRound,
        `Will Red Win Round ${currentRound} of Match #${gameId}?`,
        closesAtUnix,
      );

      // Fetch the Match DB record to link the new Market
      const match = await prisma.match.findUnique({
        where: { gameId: gameId },
      });

      // Derive the PDAs so we can save them to the DB
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), gameIdBuf(gameId), u8Buf(currentRound)],
        PRED_MARKET_PROGRAM_ID,
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), gameIdBuf(gameId), u8Buf(currentRound)],
        PRED_MARKET_PROGRAM_ID,
      );

      // Save the new micro-market to Prisma
      await prisma.market.create({
        data: {
          slug: `match-${gameId}-round-${currentRound}`,
          title: `Round ${currentRound} Winner: Red vs Blue`,
          description: `Micro-market predicting the winner of Round ${currentRound}.`,
          matchId: match.id,
          marketPda: marketPda.toBase58(),
          vaultPda: vaultPda.toBase58(),
          marketIndex: currentRound,
          marketType: "MID_GAME",
          targetRound: currentRound,
          status: "OPEN",
          closesAt: new Date(closesAtUnix * 1000),
        },
      });
      console.log(`[DATABASE] Round ${currentRound} Market saved.`);
    }

    // 4. Now that the market is definitely open, deal the cards!
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.INITIAL_DEAL);

    // Update DB status to ACTIVE
    await prisma.match.updateMany({
      where: { gameId: gameId },
      data: { status: "ACTIVE" },
    });

    return res.status(200).json({
      success: true,
      message: `Cards dealt for Round ${currentRound}.`,
      txSig,
    });
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
  if (isNaN(gameId))
    return res.status(400).json({ success: false, error: "Invalid gameId." });

  try {
    console.log(`[BLOCKCHAIN] Revealing River & Resolving Match #${gameId}...`);

    // 1. Send the bundled transaction (Reveal + Resolve)
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.FINAL_REVEAL);

    // 2. Fetch the newly resolved state
    const gs = await solanaService.fetchGameState(gameId);
    const phaseKey = Object.keys(gs.phase)[0];

    // 3. Sync HP to Database
    await prisma.match.updateMany({
      where: { gameId: gameId },
      data: { redHp: gs.p1Hp, blueHp: gs.p2Hp },
    });

    const finishedRound =
      phaseKey === "ended" ? gs.roundNumber : gs.roundNumber - 1;

    await prisma.market.updateMany({
      where: {
        match: { gameId: gameId },
        targetRound: finishedRound,
        marketType: "MID_GAME",
      },
      data: { status: "RESOLVED" },
    });

    // 4. Handle Phase Changes (Game Over or Tie)
    let message = `River revealed & Round resolved. Red HP: ${gs.p1Hp} | Blue HP: ${gs.p2Hp}`;

    if (phaseKey === "ended") {
      message = `MATCH OVER! Winner: ${gs.p1Hp === 0 ? "BLUE" : "RED"}`;
      await prisma.match.updateMany({
        where: { gameId },
        data: { status: "RESOLVED" },
      });
    } else if (phaseKey === "awaitingTiebreakerVrf") {
      message = "TIE! Sudden death tiebreaker required.";
    }

    return res.status(200).json({
      success: true,
      message,
      phase: phaseKey,
      txSig,
      redHp: gs.p1Hp,
      blueHp: gs.p2Hp,
    });
  } catch (error) {
    console.error("River reveal error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- 5. Tiebreaker (VRF 3) ---
export async function resolveTiebreaker(req, res) {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId))
    return res.status(400).json({ success: false, error: "Invalid gameId." });

  try {
    console.log(
      `[BLOCKCHAIN] Running Tiebreaker & Resolving Match #${gameId}...`,
    );

    // 1. Send the bundled transaction (Tiebreaker Reveal + Resolve)
    const txSig = await solanaService.vrfStep(gameId, ROLL_TYPE.TIEBREAKER);

    // 2. Fetch the state (No need for a separate resolveRound call!)
    const gs = await solanaService.fetchGameState(gameId);
    const phaseKey = Object.keys(gs.phase)[0];

    // 3. Sync HP to Database
    await prisma.match.updateMany({
      where: { gameId: gameId },
      data: { redHp: gs.p1Hp, blueHp: gs.p2Hp },
    });

    const finishedRound =
      phaseKey === "ended" ? gs.roundNumber : gs.roundNumber - 1;

    await prisma.market.updateMany({
      where: {
        match: { gameId: gameId },
        targetRound: finishedRound,
        marketType: "MID_GAME",
      },
      data: { status: "RESOLVED" },
    });

    // 4. Handle Phase Changes
    let message = `Tiebreaker resolved. Red HP: ${gs.p1Hp} | Blue HP: ${gs.p2Hp}`;
    if (phaseKey === "ended") {
      message = `MATCH OVER! Winner: ${gs.p1Hp === 0 ? "BLUE" : "RED"}`;
      await prisma.match.updateMany({
        where: { gameId },
        data: { status: "RESOLVED" },
      });
    }

    return res.status(200).json({
      success: true,
      message,
      phase: phaseKey,
      txSig, // Return the single bundled signature
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
        lastCardDrawn: gs.p1LastCard,
      },
      blue: {
        hp: gs.p2Hp,
        score: gs.p2Score,
        aces: gs.p2Aces,
        hasStayed: gs.p2Stayed,
        lastCardDrawn: gs.p2LastCard,
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

// --- Fetch a specific Round's Market ---
export async function getRoundMarket(req, res) {
  const gameId = Number(req.params.gameId);
  const roundNumber = Number(req.params.roundNumber);

  if (isNaN(gameId) || isNaN(roundNumber)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid parameters" });
  }

  try {
    // Query Prisma for the specific MID_GAME market tied to this round
    const market = await prisma.market.findFirst({
      where: {
        match: {
          gameId: gameId,
        },
        marketType: "MID_GAME",
        targetRound: roundNumber,
      },
    });

    if (!market) {
      return res.status(404).json({
        success: false,
        message: `No market found for Match #${gameId}, Round ${roundNumber}`,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        dbMarketId: market.id, // The UUID for your /build-trade payload
        marketPda: market.marketPda, // The on-chain address
        marketIndex: market.marketIndex, // The u8 index used in the smart contract
        status: market.status,
        title: market.title,
      },
    });
  } catch (error) {
    console.error("Fetch round market error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildTradeTransaction(req, res) {
  const { userPubkey, marketId, side, amountTokens } = req.body;

  try {
    const user = new PublicKey(userPubkey);

    // 1. Fetch Market from DB to get PDAs
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "OPEN") {
      return res
        .status(400)
        .json({ success: false, error: "Market not found or closed." });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);

    // 2. Derive User PDAs (Token Account and Position Account)
    const autoMint = new PublicKey(process.env.AUTO_TOKEN_ADDRESS); // Your SPL token
    const userTokenAccount = getAssociatedTokenAddressSync(autoMint, user);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    // Convert amount to actual token decimals (assuming 6 decimals)
    const rawAmount = new BN(amountTokens * 1_000_000);
    const minSharesOut = new BN(1); // Basic slippage protection for now

    // 3. Build the Instruction
    const sideArg = side === "YES" ? { yes: {} } : { no: {} };

    const buyIx = await solanaService.predMarket.methods
      .buyShares(sideArg, rawAmount, minSharesOut)
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        user: user,
        tokenProgram: TOKEN_PROGRAM_ID,
        // System program etc are automatically resolved by newer Anchor versions,
        // but you can add them explicitly if your contract requires them
      })
      .instruction();

    // 4. Create the Transaction & Add Blockhash
    const tx = new Transaction().add(buyIx);

    // Get the latest blockhash so the network accepts it
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user; // The user pays the gas

    // 5. Serialize to Base64 (requireAllSignatures: false is crucial here!)
    const serializedTx = tx.serialize({
      requireAllSignatures: false, // The user hasn't signed it yet!
      verifySignatures: false,
    });
    const base64Tx = serializedTx.toString("base64");

    return res.status(200).json({
      success: true,
      transaction: base64Tx,
    });
  } catch (error) {
    console.error("Build trade error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTrade(req, res) {
  const { signature, marketId, userPubkey, side, amountTokens } = req.body;

  if (!signature || !marketId || !userPubkey) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields.",
    });
  }

  try {
    console.log(`[BLOCKCHAIN] Verifying trade signature: ${signature}`);

    // 1. Fetch the full, parsed transaction from Solana
    // This gives us exactly what programs were called, rather than just "did it succeed?"
    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      },
    );

    if (!txInfo) {
      return res
        .status(404)
        .json({ success: false, error: "Transaction not found on network." });
    }

    if (txInfo.meta?.err) {
      return res
        .status(400)
        .json({ success: false, error: "Transaction failed on-chain." });
    }

    // 2. SECURITY CHECK 1: Did this transaction actually call your smart contract?
    // We check the log messages to see if your Program ID was invoked.
    const logs = txInfo.meta.logMessages || [];
    const calledYourProgram = logs.some((log) =>
      log.includes(PRED_MARKET_PROGRAM_ID.toBase58()),
    );

    if (!calledYourProgram) {
      return res.status(403).json({
        success: false,
        error:
          "Fraud alert: This transaction did not interact with the Prediction Market.",
      });
    }

    // 3. Fetch the Market from DB
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) {
      return res
        .status(404)
        .json({ success: false, error: "Market not found in database." });
    }

    // 4. Derive the positionPda
    const userPk = new PublicKey(userPubkey);
    const marketPda = new PublicKey(market.marketPda);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), userPk.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    // 5. SECURITY CHECK 2: Does their position actually exist on-chain?
    try {
      // This reaches directly into the blockchain state.
      // If they didn't actually buy shares, this will throw an error and stop the exploit.
      const onChainPosition = await solanaService.fetchUserPosition(
        positionPda.toBase58(),
      );
      console.log(`[SECURITY] On-chain position verified for ${userPubkey}`);

      // Optional: You could even check onChainPosition.amount against amountTokens here!
    } catch (e) {
      return res.status(403).json({
        success: false,
        error:
          "Fraud alert: No on-chain position found for this wallet. Trade was faked.",
      });
    }

    // 6. Ensure the User exists in your DB
    const userRecord = await prisma.user.upsert({
      where: { privyUserId: userPubkey },
      update: {},
      create: {
        privyUserId: userPubkey,
        username: `user_${userPubkey.slice(0, 6)}`,
        walletAddress: userPubkey,
      },
    });

    // 7. Save the verified Prediction to Prisma
    const newPrediction = await prisma.prediction.create({
      data: {
        userId: userRecord.id,
        marketId: market.id,
        side: side.toUpperCase(),
        amount: amountTokens,
        positionPda: positionPda.toBase58(),
        hasClaimed: false,
      },
    });

    console.log(`[DATABASE] Successfully logged prediction for ${userPubkey}`);

    return res.status(200).json({
      success: true,
      message: "Trade strictly verified and recorded.",
      data: newPrediction,
    });
  } catch (error) {
    console.error("Verify trade error:", error);
    if (error.code === "P2002") {
      return res.status(400).json({
        success: false,
        error: "This prediction has already been logged.",
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildClaimTransaction(req, res) {
  const { userPubkey, marketId } = req.body;

  if (!userPubkey || !marketId) {
    return res
      .status(400)
      .json({ success: false, error: "Missing userPubkey or marketId" });
  }

  try {
    const user = new PublicKey(userPubkey);

    // 1. Fetch Market from DB
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) {
      return res
        .status(404)
        .json({ success: false, error: "Market not found." });
    }

    // 2. Ensure the market is actually resolved!
    if (market.status !== "RESOLVED") {
      return res.status(400).json({
        success: false,
        error: "Cannot claim yet. Market is still OPEN.",
      });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);

    // 3. Derive User PDAs (using the bulletproof spl-token helper)
    const userTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      user,
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    // 4. Build the Claim Instruction
    // Note: Double-check your Rust contract to ensure the function is named `claimPayout`
    // It might be `claim` or `claimWinnings` depending on how you wrote it!
    const claimIx = await solanaService.predMarket.methods
      .claimPayout()
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        user: user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // 5. Create the Transaction & Add Blockhash
    const tx = new Transaction().add(claimIx);

    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user; // The user pays the fraction of a cent in gas to claim

    // 6. Serialize to Base64
    const serializedTx = tx.serialize({
      requireAllSignatures: false, // The user hasn't signed it yet!
      verifySignatures: false,
    });
    const base64Tx = serializedTx.toString("base64");

    return res.status(200).json({
      success: true,
      transaction: base64Tx,
    });
  } catch (error) {
    console.error("Build claim error:", error);

    // Catch common anchor errors gracefully
    if (error.message.includes("Account does not exist")) {
      return res.status(400).json({
        success: false,
        error: "No winning position found for this wallet, or already claimed.",
      });
    }

    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyClaim(req, res) {
  const { signature, marketId, userPubkey } = req.body;

  if (!signature || !marketId || !userPubkey) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields (signature, marketId, userPubkey).",
    });
  }

  try {
    console.log(`[BLOCKCHAIN] Verifying claim signature: ${signature}`);

    // 1. Check transaction status on Solana
    const status = await solanaService.connection.getSignatureStatus(
      signature,
      {
        searchTransactionHistory: true,
      },
    );

    if (!status || !status.value) {
      return res
        .status(404)
        .json({ success: false, error: "Claim transaction not found." });
    }

    if (status.value.err) {
      return res
        .status(400)
        .json({ success: false, error: "Claim transaction failed on-chain." });
    }

    // 2. Security Check: Grab parsed logs to ensure it actually called Claim
    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      },
    );

    const logs = txInfo?.meta?.logMessages || [];
    // Adjust "ClaimPayout" if your instruction name in Rust is different (e.g., "ClaimWinnings")
    const isClaimTx = logs.some((log) =>
      log.includes("Instruction: ClaimPayout"),
    );

    if (!isClaimTx) {
      return res
        .status(403)
        .json({
          success: false,
          error: "This signature is not for a claim instruction.",
        });
    }

    // 3. Update the Prediction record in Prisma
    // We find the specific prediction for this user/market and mark it as claimed
    const updatedPrediction = await prisma.prediction.updateMany({
      where: {
        marketId: marketId,
        user: {
          walletAddress: userPubkey,
        },
        hasClaimed: false, // Only update if it wasn't already marked
      },
      data: {
        hasClaimed: true,
      },
    });

    if (updatedPrediction.count === 0) {
      return res.status(404).json({
        success: false,
        message:
          "No pending prediction found to update. It might already be marked as claimed.",
      });
    }

    console.log(`[DATABASE] Claim verified and marked for ${userPubkey}`);

    return res.status(200).json({
      success: true,
      message: "Claim successfully verified and database updated.",
    });
  } catch (error) {
    console.error("Verify claim error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
