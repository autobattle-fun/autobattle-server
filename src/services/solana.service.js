import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

    // 3. Anchor Provider
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      preflightCommitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    // 4. Programs
    this.gameEngine = new anchor.Program(
      gameEngineIdl,
      GAME_ENGINE_PROGRAM_ID,
      this.provider,
    );
    this.predMarket = new anchor.Program(
      predMarketIdl,
      PRED_MARKET_PROGRAM_ID,
      this.provider,
    );

    // 5. Switchboard (lazy-initialised)
    this._sbProgram = null;
    this._sbQueue = null;

    logger.info("Solana Service initialized", {
      crank: this.crankKeypair.publicKey.toBase58(),
      gameEngine: GAME_ENGINE_PROGRAM_ID.toBase58(),
      predMarket: PRED_MARKET_PROGRAM_ID.toBase58(),
    });
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
    const registry = await this.fetchRegistry();
    return registry.gameCount.toNumber() + 1;
  }

  // ── Game Engine ─────────────────────────────────────────────────

  async initGame(gameId, agentRed, agentBlue) {
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
    const gamePda =
      typeof gamePdaOrId === "number"
        ? deriveGamePda(gamePdaOrId)[0]
        : new PublicKey(gamePdaOrId);

    return this.gameEngine.account.gameState.fetch(gamePda);
  }

  async stay(gameId, player) {
    const [gamePda] = deriveGamePda(gameId);
    const crank = this.crankKeypair.publicKey;

    const colorArg = player === "RED" ? { red: {} } : { blue: {} };

    const txSig = await this.gameEngine.methods
      .stay(colorArg)
      .accounts({
        gameState: gamePda,
        agent: crank,
      })
      .rpc();

    logger.info("Agent stayed", { gameId, player, txSig });
    return txSig;
  }

  async resolveRound(gameId, marketPda) {
    const [registryPda] = deriveRegistryPda();
    const [gamePda] = deriveGamePda(gameId);
    const crank = this.crankKeypair.publicKey;

    const remainingAccounts = marketPda
      ? [
          {
            pubkey: new PublicKey(marketPda),
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: PRED_MARKET_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
        ]
      : [];

    const txSig = await this.gameEngine.methods
      .resolveRound()
      .accounts({
        registry: registryPda,
        gameState: gamePda,
        crank: crank,
      })
      .remainingAccounts(remainingAccounts)
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
  async vrfStep(gameId, rollType) {
    await this._ensureSwitchboard();

    const [gamePda] = deriveGamePda(gameId);
    const [vrfRequestPda] = deriveVrfRequestPda(gameId);
    const crank = this.crankKeypair.publicKey;

    // 1. Create randomness account
    const rngKeypair = Keypair.generate();
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
        randomnessAccount: rngKeypair.publicKey,
        agent: crank,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await this.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(commitIx, reqIx),
    );

    // 3. Wait for oracle to settle
    await this._sleep(VRF_SETTLE_DELAY_MS);

    // 4. Reveal + Fulfill (atomic)
    const revealIx = await randomness.revealIx();
    const fillIx = await this.gameEngine.methods
      .fulfillVrf()
      .accounts({
        gameState: gamePda,
        vrfRequest: vrfRequestPda,
        randomnessAccount: rngKeypair.publicKey,
        crank: crank,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const txSig = await this.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(revealIx, fillIx),
    );

    logger.info("VRF step complete", { gameId, rollType, txSig });
    return txSig;
  }

  // ── Prediction Market ───────────────────────────────────────────

  async createOnChainMarket(gameId, marketIndex, question, expiresAtUnix) {
    const [marketPda] = deriveMarketPda(gameId, marketIndex);
    const [vaultPda] = deriveVaultPda(gameId, marketIndex);
    const crank = this.crankKeypair.publicKey;

    const autoMint = env.AUTO_MINT_ADDRESS
      ? new PublicKey(env.AUTO_MINT_ADDRESS)
      : crank; // Fallback for testing (see test.controller.js pattern)

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

  // ── Helpers ─────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { ROLL_TYPE };
export const solanaService = new SolanaService();
