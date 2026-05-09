import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as sb from "@switchboard-xyz/on-demand";
import BN from "bn.js";
import fs from "fs";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  deriveRegistryPda,
  deriveGamePda,
  deriveVrfRequestPda,
  deriveMarketPda,
  deriveVaultPda,
} from "../utils/solana.helpers.js";
import bs58 from "bs58";

// ── IDL Loading ─────────────────────────────────────────────────────

const gameEngineIdl = JSON.parse(
  fs.readFileSync(new URL("../idls/game_engine.json", import.meta.url)),
);
const predMarketIdl = JSON.parse(
  fs.readFileSync(new URL("../idls/prediction_market.json", import.meta.url)),
);

// ── Program IDs ─────────────────────────────────────────────────────

export const GAME_ENGINE_PROGRAM_ID = new PublicKey(
  gameEngineIdl.address ?? gameEngineIdl.metadata?.address,
);
export const PRED_MARKET_PROGRAM_ID = new PublicKey(
  predMarketIdl.address ?? predMarketIdl.metadata?.address,
);

// ── VRF Constants ───────────────────────────────────────────────────

const VRF_SETTLE_DELAY_MS = 3_000;

const ROLL_TYPE = Object.freeze({
  INITIAL_DEAL: 0,
  HIT: 1,
  FINAL_REVEAL: 2,
  TIEBREAKER: 3,
});

// ── Service ─────────────────────────────────────────────────────────

class SolanaService {
  constructor() {
    // 1. Connection
    this.connection = new Connection(env.SOLANA_RPC_URL, "confirmed");

    // 2. Crank Wallet
    const secretKeyArray = Uint8Array.from(JSON.parse(env.CRANK_PRIVATE_KEY));
    this.crankKeypair = Keypair.fromSecretKey(secretKeyArray);
    this.wallet = new anchor.Wallet(this.crankKeypair);

    // 3. Agent Wallets (separate keypairs for Red/Blue agent signing)
    const redKeyArray = bs58.decode(env.AGENT_RED_PRIVATE_KEY);
    this.agentRedKeypair = Keypair.fromSecretKey(redKeyArray);

    const blueKeyArray = bs58.decode(env.AGENT_BLUE_PRIVATE_KEY);
    this.agentBlueKeypair = Keypair.fromSecretKey(blueKeyArray);

    // 4. Anchor Provider
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      preflightCommitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    // 5. Programs
    this.gameEngine = new anchor.Program(gameEngineIdl, this.provider);

    this.predMarket = new anchor.Program(predMarketIdl, this.provider);

    // 6. Switchboard (lazy-initialised)
    this._sbProgram = null;
    this._sbQueue = null;

    logger.info("Solana Service initialized", {
      crank: this.crankKeypair.publicKey.toBase58(),
      agentRed: this.agentRedKeypair.publicKey.toBase58(),
      agentBlue: this.agentBlueKeypair.publicKey.toBase58(),
      gameEngine: GAME_ENGINE_PROGRAM_ID.toBase58(),
      predMarket: PRED_MARKET_PROGRAM_ID.toBase58(),
    });
  }

  /**
   * Get the keypair for a specific agent color.
   * @param {"RED" | "BLUE"} player
   * @returns {Keypair}
   */
  getAgentKeypair(player) {
    return player === "RED" ? this.agentRedKeypair : this.agentBlueKeypair;
  }

  // ── Mocking Logic ───────────────────────────────────────────────

  _getMockGameState(gameId) {
    if (!this._mockGames) this._mockGames = {};
    if (!this._mockGames[gameId]) {
      this._mockGames[gameId] = {
        gameId: new BN(gameId),
        agentRed: this.agentRedKeypair.publicKey,
        agentBlue: this.agentBlueKeypair.publicKey,
        p1Hp: 10,
        p2Hp: 10,
        p1Score: 0,
        p2Score: 0,
        p1Aces: 0,
        p2Aces: 0,
        p1Stayed: false,
        p2Stayed: false,
        roundNumber: 1,
        phase: { awaitingInitialDealVrf: {} },
        activePlayer: { red: {} },
        winner: null,
      };
    }
    return this._mockGames[gameId];
  }

  _generateMockTx() {
    return "mock_tx_" + Math.random().toString(36).substring(7);
  }

  // ── Switchboard Lazy Init ───────────────────────────────────────

  async _ensureSwitchboard() {
    if (this._sbProgram) return;

    const sbProgramId = new PublicKey(env.SWITCHBOARD_PROGRAM_ID);
    const sbIdl = await anchor.Program.fetchIdl(sbProgramId, this.provider);

    if (!sbIdl) {
      throw new Error(
        `Failed to fetch Switchboard IDL for ${sbProgramId.toBase58()}`,
      );
    }

    this._sbProgram = new anchor.Program(sbIdl, this.provider);
    this._sbQueue = await sb.getDefaultQueue(this.connection.rpcEndpoint);

    logger.info("Switchboard initialized", {
      queue: this._sbQueue.pubkey.toBase58(),
    });
  }

  // ── Registry ────────────────────────────────────────────────────

  async fetchRegistry() {
    if (env.MOCK_SOLANA) {
      return {
        gameCount: new BN(Object.keys(this._mockGames || {}).length + 20),
      };
    }
    const [registryPda] = deriveRegistryPda();
    return this.gameEngine.account.registry.fetch(registryPda);
  }

  async initializeRegistry(cooldownDuration = 300) {
    const [registryPda] = deriveRegistryPda();
    const crank = this.crankKeypair.publicKey;

    const txSig = await this.gameEngine.methods
      .initializeRegistry(new BN(cooldownDuration))
      .accounts({
        registry: registryPda,
        authority: crank,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.info("Registry initialized", { txSig });
    return txSig;
  }

  async getNextGameId() {
    if (env.MOCK_SOLANA) {
      return Math.floor(Date.now() / 1000) % 1000000;
    }
    const registry = await this.fetchRegistry();
    return registry.gameCount.toNumber() + 1;
  }

  // ── Game Engine ─────────────────────────────────────────────────

  async initGame(gameId, agentRed, agentBlue) {
    if (env.MOCK_SOLANA) {
      this._getMockGameState(gameId);
      return this._generateMockTx();
    }
    const [registryPda] = deriveRegistryPda();
    const [gamePda] = deriveGamePda(gameId);
    const crank = this.crankKeypair.publicKey;

    const txSig = await this.gameEngine.methods
      .initGame(new PublicKey(agentRed), new PublicKey(agentBlue))
      .accounts({
        registry: registryPda,
        gameState: gamePda,
        crank: crank,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.info("Game initialized", { gameId, txSig });
    return txSig;
  }

  async fetchGameState(gamePdaOrId) {
    if (env.MOCK_SOLANA) {
      let gameId = typeof gamePdaOrId === "number" ? gamePdaOrId : null;
      if (!gameId && this._mockGames) {
        // Fallback to the first mock game if we only have one
        const ids = Object.keys(this._mockGames);
        if (ids.length > 0) gameId = parseInt(ids[0]);
      }
      return this._getMockGameState(gameId || 999);
    }
    const gamePda =
      typeof gamePdaOrId === "number"
        ? deriveGamePda(gamePdaOrId)[0]
        : new PublicKey(gamePdaOrId);

    return this.gameEngine.account.gameState.fetch(gamePda);
  }

  async stay(gameId, player) {
    if (env.MOCK_SOLANA) {
      const gs = this._getMockGameState(gameId);
      if (player === "RED") gs.p1Stayed = true;
      else gs.p2Stayed = true;
      return this._generateMockTx();
    }
    const [gamePda] = deriveGamePda(gameId);
    const agentKp = this.getAgentKeypair(player);

    const colorArg = player === "RED" ? { red: {} } : { blue: {} };

    const stayIx = await this.gameEngine.methods
      .stay(colorArg)
      .accounts({
        gameState: gamePda,
        agent: agentKp.publicKey,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(stayIx);
    const txSig = await this.provider.sendAndConfirm(tx, [agentKp]);

    logger.info("Agent stayed", { gameId, player, txSig });
    return txSig;
  }

  async resolveRound(gameId) {
    const [registryPda] = deriveRegistryPda();
    const [gamePda] = deriveGamePda(gameId);
    const crank = this.crankKeypair.publicKey;

    // Fetch current state to know the round number
    const currentState = await this.gameEngine.account.gameState.fetch(gamePda);
    const currentRound = currentState.roundNumber;

    // Derive BOTH markets to satisfy the new contract requirements
    const [roundMarketPda] = deriveMarketPda(gameId, currentRound);
    const [mainMarketPda] = deriveMarketPda(gameId, 0);

    const txSig = await this.gameEngine.methods
      .resolveRound()
      .accounts({
        registry: registryPda,
        gameState: gamePda,
        crank: crank,
      })
      .remainingAccounts([
        { pubkey: roundMarketPda, isWritable: true, isSigner: false }, // index 0 (Round)
        { pubkey: mainMarketPda, isWritable: true, isSigner: false }, // index 1 (Main)
        { pubkey: PRED_MARKET_PROGRAM_ID, isWritable: false, isSigner: false },
      ])
      .rpc();

    logger.info("Round resolved", { gameId, txSig });
    return txSig;
  }
  // ── VRF Lifecycle ───────────────────────────────────────────────

  /**
   * Full VRF lifecycle:
   * 1. Create randomness account
   * 2. Commit randomness
   * 3. Call request_vrf on-chain
   * 4. Wait for oracle settlement
   * 5. Reveal randomness
   * 6. Call fulfill_vrf on-chain
   */
  /**
   * @param {number} gameId
   * @param {number} rollType - ROLL_TYPE enum value
   * @param {"RED" | "BLUE"} [agentColor] - Which agent signs the request_vrf.
   *   For initial deal (type 0), final reveal (type 2), and tiebreaker (type 3),
   *   the crank signs. For hit (type 1), the active agent signs.
   */
  async vrfStep(gameId, rollType, agentColor) {
    if (env.MOCK_SOLANA) {
      const gs = this._getMockGameState(gameId);
      // Simulate state changes based on rollType
      if (rollType === 0) {
        // INITIAL_DEAL
        gs.p1Score = Math.floor(Math.random() * 10) + 1;
        gs.p2Score = Math.floor(Math.random() * 10) + 1;
        gs.phase = { awaitingAction: {} };
      } else if (rollType === 1) {
        // HIT
        const cardVal = Math.floor(Math.random() * 10) + 1;
        if (agentColor === "RED") {
          gs.p1Score += cardVal;
          gs.p1LastCard = cardVal;
        } else {
          gs.p2Score += cardVal;
          gs.p2LastCard = cardVal;
        }
        if (gs.p1Score >= 21) gs.p1Stayed = true;
        if (gs.p2Score >= 21) gs.p2Stayed = true;
      } else if (rollType === 2) {
        // FINAL_REVEAL
        const p1CardValue = Math.floor(Math.random() * 10) + 1;
        const p2CardValue = Math.floor(Math.random() * 10) + 1;
        
        gs.p1LastCard = p1CardValue;
        gs.p2LastCard = p2CardValue;
        gs.p1Score += p1CardValue;
        gs.p2Score += p2CardValue;

        // Simple win/lose logic for simulation
        if (gs.p1Score === gs.p2Score && gs.p1Score <= 21) {
          gs.phase = { awaitingTiebreakerVrf: {} };
          return this._generateMockTx();
        } else if (gs.p1Score > 21 && gs.p2Score > 21) {
          /* tie, no HP change */
        } else if (gs.p1Score > 21) gs.p1Hp -= 1;
        else if (gs.p2Score > 21) gs.p2Hp -= 1;
        else if (gs.p1Score > gs.p2Score) gs.p2Hp -= 1;
        else if (gs.p1Score < gs.p2Score) gs.p1Hp -= 1;

        if (gs.p1Hp <= 0 || gs.p2Hp <= 0) {
          gs.phase = { ended: {} };
        } else {
          // IMPORTANT: Do NOT reset scores here in the mock if we want the service to read them!
          // In the real contract, they might be reset by resolveRound, but for the mock
          // we'll keep them until the next round's INITIAL_DEAL.
          gs.roundNumber += 1;
          gs.p1Stayed = false;
          gs.p2Stayed = false;
          gs.phase = { awaitingInitialDealVrf: {} };
        }
      } else if (rollType === 3) {
        // TIEBREAKER
        const p1CardValue = Math.floor(Math.random() * 10) + 1;
        const p2CardValue = Math.floor(Math.random() * 10) + 1;

        gs.p1LastCard = p1CardValue;
        gs.p2LastCard = p2CardValue;

        // In tiebreaker, draw until someone wins or just simulate a result
        if (p1CardValue > p2CardValue) {
          gs.p2Hp -= 1;
        } else if (p2CardValue > p1CardValue) {
          gs.p1Hp -= 1;
        }
        // If they are equal, it remains in AWAITING_TIEBREAKER_VRF and loops again

        if (gs.p1Hp <= 0 || gs.p2Hp <= 0) {
          gs.phase = { ended: {} };
        } else if (p1CardValue !== p2CardValue) {
          // Round resolved, next round
          gs.roundNumber += 1;
          gs.p1Stayed = false;
          gs.p2Stayed = false;
          gs.phase = { awaitingInitialDealVrf: {} };
        }
      }
      return this._generateMockTx();
    }
    await this._ensureSwitchboard();

    const [gamePda] = deriveGamePda(gameId);
    const [vrfRequestPda] = deriveVrfRequestPda(gameId);
    const crank = this.crankKeypair.publicKey;

    // Determine who signs the request_vrf instruction
    const isAgentSigned = rollType === 1 && agentColor;
    const signerKp = isAgentSigned
      ? this.getAgentKeypair(agentColor)
      : this.crankKeypair;

    let rngPubkey;

    // --- FIX: Check if the PDA already exists to prevent "already in use" errors during retries ---
    const vrfReqInfo = await this.connection.getAccountInfo(vrfRequestPda);

    if (vrfReqInfo) {
      const vrfReqData =
        await this.gameEngine.account.vrfRequest.fetch(vrfRequestPda);

      // The 'consumed' field was removed from the smart contract.
      // Because `fulfill_vrf` deletes the PDA entirely, if this account still exists,
      // we know for a fact it is pending and needs to be revealed!
      rngPubkey = vrfReqData.sbAccount;
      logger.info(
        "Recovered existing VRF request. Retrying reveal/fulfill...",
        { gameId, rollType },
      );
    } else {
      // 1. Create randomness account (Normal Flow)
      const rngKeypair = Keypair.generate();
      rngPubkey = rngKeypair.publicKey;

      const [randomness, createIx] = await sb.Randomness.create(
        this._sbProgram,
        rngKeypair,
        this._sbQueue.pubkey,
      );

      await this.provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          createIx,
        ),
        [rngKeypair],
      );

      // 2. Commit + Request VRF (atomic)
      const commitIx = await randomness.commitIx(this._sbQueue.pubkey);
      const reqIx = await this.gameEngine.methods
        .requestVrf(rollType)
        .accounts({
          gameState: gamePda,
          vrfRequest: vrfRequestPda,
          randomnessAccount: rngPubkey,
          agent: signerKp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const commitTx = new anchor.web3.Transaction().add(commitIx, reqIx);
      // Include agent keypair as additional signer if it's not the crank
      const commitSigners = isAgentSigned ? [signerKp] : [];
      await this.provider.sendAndConfirm(commitTx, commitSigners);
    }

    // 3. Wait for oracle to settle
    await this._sleep(VRF_SETTLE_DELAY_MS);

    // 4. Reveal + Fulfill (atomic)
    // Instantiate the randomness object using the pubkey we either created or recovered
    const randomness = new sb.Randomness(this._sbProgram, rngPubkey);

    let revealIx;
    try {
      revealIx = await randomness.revealIx();
    } catch (error) {
      if (error.isAxiosError || error.name === 'AxiosError') {
        try {
          const data = await randomness.loadData();
          const oracle = new sb.Oracle(this._sbProgram, data.oracle);
          const oracleData = await oracle.loadData();
          const gatewayUrl = String.fromCharCode(...oracleData.gatewayUri).replace(/\0+$/, "");

          const errorDetails = {
            randomnessAccount: rngPubkey.toBase58(),
            seedSlot: data.seedSlot.toNumber(),
            oraclePubkey: data.oracle.toBase58(),
            gatewayUrl,
            status: error.response?.status,
            responseBody: error.response?.data,
            configUrl: error.config?.url,
            timestamp: new Date().toISOString()
          };

          logger.error("Switchboard VRF Reveal Error details", errorDetails);
          error.message = `Switchboard VRF Reveal Error: ${error.message}\nDetails: ${JSON.stringify(errorDetails, null, 2)}`;
        } catch (innerErr) {
          logger.error("Failed to load Switchboard metadata for error decoration", { err: innerErr.message });
        }
      }
      throw error;
    }

    const fillIx = await this.gameEngine.methods
      .fulfillVrf()
      .accounts({
        gameState: gamePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: rngPubkey,
        crank: crank,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(revealIx, fillIx);

    // --- MEV BOT PROTECTION: ATOMIC RESOLUTION ---
    // If this is the Final Reveal (2) or Tiebreaker (3), immediately bundle the resolve command
    if (rollType === 2 || rollType === 3) {
      const [registryPda] = deriveRegistryPda();

      // Fetch the current round number before the contract increments it
      const currentState =
        await this.gameEngine.account.gameState.fetch(gamePda);
      const currentRound = currentState.roundNumber;

      // Derive BOTH markets
      const [roundMarketPda] = deriveMarketPda(gameId, currentRound);
      const [mainMarketPda] = deriveMarketPda(gameId, 0);

      const resolveIx = await this.gameEngine.methods
        .resolveRound()
        .accounts({
          registry: registryPda,
          gameState: gamePda,
          crank: crank,
        })
        .remainingAccounts([
          { pubkey: roundMarketPda, isWritable: true, isSigner: false }, // index 0 (Round)
          { pubkey: mainMarketPda, isWritable: true, isSigner: false }, // index 1 (Main)
          {
            pubkey: PRED_MARKET_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
        ])
        .instruction();

      tx.add(resolveIx);
    }

    const txSig = await this.provider.sendAndConfirm(tx);
    logger.info("VRF step complete", { gameId, rollType, agentColor, txSig });
    return txSig;
  }

  // ── Prediction Market ───────────────────────────────────────────

  async createOnChainMarket(gameId, marketIndex, question, expiresAtUnix) {
    if (env.MOCK_SOLANA) return this._generateMockTx();
    const [marketPda] = deriveMarketPda(gameId, marketIndex);
    const [vaultPda] = deriveVaultPda(gameId, marketIndex);
    const crank = this.crankKeypair.publicKey;

    const autoMint = env.AUTO_TOKEN_ADDRESS
      ? new PublicKey(env.AUTO_TOKEN_ADDRESS)
      : crank; // Fallback for testing (see test.controller.js pattern)

    // --- NEW: Derive the Crank's Token Account ---
    const creatorTokenAccount = getAssociatedTokenAddressSync(autoMint, crank);

    const txSig = await this.predMarket.methods
      .createMarket(
        new BN(gameId),
        marketIndex,
        question,
        new BN(expiresAtUnix),
      )
      .accounts({
        market: marketPda,
        vault: vaultPda,
        autoMint: autoMint,
        creatorTokenAccount: creatorTokenAccount, // <-- NEW: Add the LP source
        authority: crank,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .rpc();

    logger.info("On-chain market created", { gameId, marketIndex, txSig });
    return txSig;
  }

  async fetchMarketState(marketPdaAddress) {
    return this.predMarket.account.market.fetch(
      new PublicKey(marketPdaAddress),
    );
  }

  async fetchUserPosition(positionPdaAddress) {
    return this.predMarket.account.userPosition.fetch(
      new PublicKey(positionPdaAddress),
    );
  }

  async retrieveLp(marketPdaAddress, vaultPdaAddress) {
    if (env.MOCK_SOLANA) return this._generateMockTx();
    const crank = this.crankKeypair.publicKey;

    const autoMint = env.AUTO_TOKEN_ADDRESS
      ? new PublicKey(env.AUTO_TOKEN_ADDRESS)
      : crank; // Fallback for testing

    const creatorTokenAccount = getAssociatedTokenAddressSync(autoMint, crank);

    const txSig = await this.predMarket.methods
      .withdrawLp()
      .accounts({
        market: new PublicKey(marketPdaAddress),
        vault: new PublicKey(vaultPdaAddress),
        adminTokenAccount: creatorTokenAccount,
        authority: crank,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.crankKeypair])
      .rpc();

    logger.info("LP retrieved for market", { marketPdaAddress, txSig });
    return txSig;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { ROLL_TYPE };
export const solanaService = new SolanaService();
