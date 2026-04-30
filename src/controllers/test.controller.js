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
import { broadcast, wsEvents } from "../lib/websocket.js";

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

    const creatorTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      crank,
    );

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
        creatorTokenAccount: creatorTokenAccount,
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
        creatorTokenAccount: creatorTokenAccount,
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

// --- WEBSOCKET EVENT TESTING ---

export const fireEventMethods = {
  fireMatchCreated: async (req, res) => {
    try {
      broadcast(
        "match:created",
        {
          game: {
            gameId: 999,
            gameStatus: "ACTIVE",
            serverStatus: "ACTIVE",
            activePlayer: { color: "RED", name: "Donald Trump" },
            playerStatus: { red: "WAITING", blue: "WAITING" },
            phase: "AwaitingInitialDeal",
            roundNumber: 1,
            red: {
              hp: 10,
              score: 0,
              name: "Donald Trump",
              llm: "llama-3",
              cards: [],
            },
            blue: {
              hp: 10,
              score: 0,
              name: "Joe Biden",
              llm: "mixtral",
              cards: [],
            },
          },

          market: {
            mainMarket: {
              id: "cmoljf1ap0001gx8ovd7lhv42",
              matchId: "cmoljf12o0000gx8o44w41lgg",
              marketIndex: 0,
              targetRound: null,
              status: "OPEN",

              yesPrice: 0.63,
              noPrice: 0.37,
              totalVolumeRaw: 1000,
            },
            roundMarket: {
              // Send Round Market only when first round market is created
              id: "cmoljf1ia0002gx8ooa94ac1e",
              matchId: "cmoljf12o0000gx8o44w41lgg",
              marketIndex: 1,
              targetRound: 2,
              status: "OPEN",

              yesPrice: 0.63,
              noPrice: 0.37,
              totalVolumeRaw: 900,
            },
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired matchCreated" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireRoundStarted: async (req, res) => {
    try {
      broadcast(
        "round:started",
        {
          roundNumber: 2,
        },
        999,
      );
      res.json({ success: true, message: "Fired roundStarted" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireCardsDealt: async (req, res) => {
    try {
      broadcast(
        "cards:dealt",
        {
          game: {
            activePlayer: { color: "RED", name: "Donald Trump" },
            playerStatus: { red: "THINKING", blue: "WAITING" },
            phase: "RedTurn",
            red: {
              hp: 9,
              score: 15,
              name: "Donald Trump",
              llm: "llama-3",
              cards: [
                { value: 7, label: "7" },
                { value: 8, label: "8" },
              ],
            },
            blue: {
              hp: 8,
              score: 12,
              name: "Joe Biden",
              llm: "mixtral",
              cards: [
                { value: 10, label: "10" },
                { value: 2, label: "2" },
              ],
            },
          },
          market: {
            mainMarket: {
              id: "cmoljf1ap0001gx8ovd7lhv42",
              matchId: "cmoljf12o0000gx8o44w41lgg",
              marketIndex: 0,
              targetRound: null,
              status: "OPEN",

              yesPrice: 0.63,
              noPrice: 0.37,
              totalVolumeRaw: 1000,
            },
            roundMarket: {
              // Send Round Market only when first round market is created
              id: "cmoljf1ia0002gx8ooa94ac1e",
              matchId: "cmoljf12o0000gx8o44w41lgg",
              marketIndex: 1,
              targetRound: 3,
              status: "OPEN",

              yesPrice: 0.63,
              noPrice: 0.37,
              totalVolumeRaw: 900,
            },
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired cardsDealt" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireAgentDecision: async (req, res) => {
    try {
      const { playerStatus } = req.params;
      const isFinalized =
        playerStatus === "FINALIZED" || playerStatus === "DONE";

      broadcast(
        "agent:decision",
        {
          playerStatus: { red: playerStatus, blue: "WAITING" },
          ...(isFinalized && {
            red: {
              hp: 9,
              score: 23,
              name: "Donald Trump",
              llm: "llama-3",
              cards: [
                { value: 7, label: "7" },
                { value: 8, label: "8" },
                { value: 11, label: "1" },
              ],
            },
            blue: {
              hp: 8,
              score: 12,
              name: "Joe Biden",
              llm: "mixtral",
              cards: [
                { value: 10, label: "10" },
                { value: 2, label: "2" },
              ],
            },
          }),
        },
        999,
      );
      res.json({ success: true, message: "Fired agentDecision" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireRiverFlowing: async (req, res) => {
    try {
      broadcast(
        "river:flowing",
        {
          playerStatus: { red: "WAITING", blue: "WAITING" },
          phase: "AwaitingFinalReveal",
        },
        999,
      );
      res.json({ success: true, message: "Fired riverRevealed" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireRoundResolved: async (req, res) => {
    try {
      broadcast(
        "round:resolved",
        {
          playerStatus: { red: "WAITING", blue: "WAITING" },
          phase: "RedWon",
          red: {
            hp: 9,
            score: 15,
            name: "Donald Trump",
            llm: "llama-3",
            cards: [
              { value: 7, label: "7" },
              { value: 8, label: "8" },
              { value: 10, label: "10" },
            ],
          },
          blue: {
            hp: 8,
            score: 12,
            name: "Joe Biden",
            llm: "mixtral",
            cards: [
              { value: 10, label: "10" },
              { value: 2, label: "2" },
              { value: 5, label: "5" },
            ],
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired roundResolved" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireTiebreakerStarted: async (req, res) => {
    try {
      broadcast(
        "tiebreaker:started",
        {
          phase: "AwaitingTiebreaker",
        },
        999,
      );
      res.json({ success: true, message: "Fired tiebreakerStarted" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireTiebreakerResolved: async (req, res) => {
    try {
      broadcast(
        "tiebreaker:resolved",
        {
          playerStatus: { red: "WAITING", blue: "WAITING" },
          phase: "BlueWon",
          red: {
            hp: 2,
            score: 15,
            name: "Donald Trump",
            llm: "llama-3",
            cards: [
              { value: 7, label: "7" },
              { value: 8, label: "8" },
              { value: 10, label: "10" },
            ],
          },
          blue: {
            hp: 1,
            score: 12,
            name: "Joe Biden",
            llm: "mixtral",
            cards: [
              { value: 10, label: "10" },
              { value: 2, label: "2" },
              { value: 5, label: "5" },
            ],
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired tiebreakerResolved" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireMatchEnded: async (req, res) => {
    try {
      broadcast(
        "match:ended",
        {
          phase: "Ended",
          gameId: 999,
          red: {
            hp: 0,
            score: 15,
            name: "Donald Trump",
            llm: "llama-3",
            cards: [
              { value: 7, label: "7" },
              { value: 8, label: "8" },
            ],
          },
          blue: {
            hp: 8,
            score: 12,
            name: "Joe Biden",
            llm: "mixtral",
            cards: [
              { value: 10, label: "10" },
              { value: 2, label: "2" },
            ],
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired matchEnded" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireGamePaused: async (req, res) => {
    try {
      broadcast(
        "game:paused",
        {
          gameId: 999,
          serverStatus: "PAUSED",
          reason: "Manual intervention",
          error: "RPC timeout",
        },
        999,
      );
      res.json({ success: true, message: "Fired gamePaused" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireGameResumed: async (req, res) => {
    try {
      broadcast(
        "game:resumed",
        {
          gameId: 999,
        },
        999,
      );
      res.json({ success: true, message: "Fired gameResumed" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireMarketPrices: async (req, res) => {
    try {
      broadcast(
        "market:prices",
        {
          mainMarket: {
            id: "cmoljf1ap0001gx8ovd7lhv42",
            matchId: "cmoljf12o0000gx8o44w41lgg",
            marketIndex: 0,
            targetRound: null,
            status: "OPEN",

            yesPrice: 0.63,
            noPrice: 0.37,
            totalVolumeRaw: 1000,
          },
          roundMarket: {
            id: "cmoljf1ia0002gx8ooa94ac1e",
            matchId: "cmoljf12o0000gx8o44w41lgg",
            marketIndex: 1,
            targetRound: 2,
            status: "OPEN",

            yesPrice: 0.63,
            noPrice: 0.37,
            totalVolumeRaw: 900,
          },
        },
        999,
      );
      res.json({ success: true, message: "Fired marketPrices" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  fireLogBroadcast: async (req, res) => {
    try {
      wsEvents.logBroadcast("System", "This is a dummy log message for testing");
      res.json({ success: true, message: "Fired logBroadcast" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
  firePong: async (req, res) => {
    try {
      wsEvents.pong({
        latency: 42,
        gameState: {
          matchId: "dummy-match-id-123",
          gameId: 999,
          gameStatus: "ACTIVE",
          serverStatus: "ACTIVE",
          activePlayer: { color: "RED", name: "Donald Trump" },
          playerStatus: { red: "THINKING", blue: "WAITING" },
          roundNumber: 1,
          red: {
            hp: 10,
            score: 15,
            name: "Donald Trump",
            llm: "llama-3",
            cards: [],
          },
          blue: {
            hp: 10,
            score: 12,
            name: "Joe Biden",
            llm: "mixtral",
            cards: [],
          },
          cardHistory: {
            pastRounds: [],
            currentRound: { redCards: [], blueCards: [] },
          },
        },
        countdown: null,
        serverTimestamp: Date.now(),
      });
      res.json({ success: true, message: "Fired pong" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
};

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
      return res.status(403).json({
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

export async function buildSellTransaction(req, res) {
  const { userPubkey, marketId, side, amountShares } = req.body;

  try {
    const user = new PublicKey(userPubkey);

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "OPEN") {
      return res
        .status(400)
        .json({ success: false, error: "Market not found or closed." });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const userTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      user,
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    const rawAmount = new BN(Math.floor(amountShares * 1_000_000));
    const minTokensOut = new BN(1); // Slippage protection

    const sideArg = side.toUpperCase() === "YES" ? { yes: {} } : { no: {} };

    // Note: Verify the exact method name in your Rust contract (e.g., sellShares)
    const sellIx = await solanaService.predMarket.methods
      .sellShares(sideArg, rawAmount, minTokensOut)
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        user: user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(sellIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
    });
  } catch (error) {
    console.error("Build sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifySell(req, res) {
  const { signature, marketId, userPubkey, side, amountShares } = req.body;

  try {
    const status = await solanaService.connection.getSignatureStatus(
      signature,
      { searchTransactionHistory: true },
    );
    if (!status?.value || status.value.err) {
      return res
        .status(400)
        .json({ success: false, error: "Transaction failed or not found." });
    }

    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    const logs = txInfo?.meta?.logMessages || [];

    // Adjust this to match your Rust instruction log!
    if (!logs.some((log) => log.includes("Instruction: SellShares"))) {
      return res
        .status(403)
        .json({ success: false, error: "Not a valid sell transaction." });
    }

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    let dbSide =
      side.toUpperCase() === "RED"
        ? "YES"
        : side.toUpperCase() === "BLUE"
          ? "NO"
          : side.toUpperCase();

    const userRecord = await prisma.user.findUnique({
      where: { privyUserId: userPubkey },
    });
    if (!userRecord)
      return res.status(404).json({ success: false, error: "User not found." });

    // Use Prisma's atomic decrement to safely reduce their position
    await prisma.prediction.updateMany({
      where: {
        userId: userRecord.id,
        marketId: market.id,
        side: dbSide,
      },
      data: {
        amount: {
          decrement: amountShares,
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Sell successfully verified and recorded.",
    });
  } catch (error) {
    console.error("Verify sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function retrieveLp(req, res) {
  const marketId = req.params.marketId;

  try {
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "RESOLVED") {
      return res.status(400).json({
        success: false,
        error: "Market must be resolved to retrieve LP.",
      });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const crank = solanaService.crankKeypair;
    const creatorTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      crank.publicKey,
    );

    // Call the retrieve function (Check your Rust contract for the exact name, e.g., retrieveLp or withdrawLiquidity)
    const txSig = await solanaService.predMarket.methods
      .withdrawLp()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        adminTokenAccount: creatorTokenAccount,
        authority: crank.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([crank]) // The backend signs this automatically!
      .rpc();

    return res.status(200).json({
      success: true,
      message: `LP successfully retrieved for market ${market.slug}`,
      txSig: txSig,
    });
  } catch (error) {
    console.error("Retrieve LP error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function getMarketPrices(req, res) {
  const { marketId } = req.params;

  try {
    // 1. Fetch Market from DB to get the PDA
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) {
      return res
        .status(404)
        .json({ success: false, error: "Market not found in DB." });
    }

    // 2. Fetch the live on-chain state
    const marketState = await solanaService.fetchMarketState(market.marketPda);

    // 3. Extract supplies
    const yesSupply = marketState.yesSupply.toNumber();
    const noSupply = marketState.noSupply.toNumber();

    // This MUST match your Rust contract's LMSR_B_SCALED constant exactly!
    const LMSR_B_SCALED = 14_427_000_000;

    // 4. Calculate prices using the overflow-safe LMSR Marginal Price formula
    // p_yes = 1 / (1 + e^((n - y) / b))
    const pYes = 1 / (1 + Math.exp((noSupply - yesSupply) / LMSR_B_SCALED));
    const pNo = 1 - pYes; // The probabilities must always equal 1.0 (100%)

    return res.status(200).json({
      success: true,
      data: {
        status: market.status,
        yesPrice: parseFloat(pYes.toFixed(4)), // e.g., 0.5000 (50 cents)
        noPrice: parseFloat(pNo.toFixed(4)),
        yesSupplyRaw: yesSupply,
        noSupplyRaw: noSupply,
        totalVolumeRaw: marketState.totalVolume.toNumber(),
      },
    });
  } catch (error) {
    console.error("Fetch market prices error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function getUserPosition(req, res) {
  const { marketId, userPubkey } = req.params;

  if (!marketId || !userPubkey) {
    return res
      .status(400)
      .json({ success: false, error: "Missing parameters." });
  }

  try {
    const userPk = new PublicKey(userPubkey);

    // 1. Fetch Market from DB to get the PDA
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) {
      return res
        .status(404)
        .json({ success: false, error: "Market not found in DB." });
    }

    const marketPda = new PublicKey(market.marketPda);

    // 2. Derive the UserPosition PDA
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), userPk.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    // 3. Fetch the position from the blockchain
    try {
      const position = await solanaService.fetchUserPosition(
        positionPda.toBase58(),
      );

      // The shares are stored in 6 decimals, so we divide by 1,000,000 to get the human-readable number
      const yesShares = position.yesShares.toNumber() / 1_000_000;
      const noShares = position.noShares.toNumber() / 1_000_000;

      return res.status(200).json({
        success: true,
        data: {
          yesShares: yesShares,
          noShares: noShares,
          hasClaimed: position.claimed,
        },
      });
    } catch (e) {
      // If Anchor throws an "Account does not exist" error, it just means
      // the user has never traded in this market before. Their balance is 0.
      return res.status(200).json({
        success: true,
        data: {
          yesShares: 0,
          noShares: 0,
          hasClaimed: false,
        },
      });
    }
  } catch (error) {
    console.error("Fetch user position error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
