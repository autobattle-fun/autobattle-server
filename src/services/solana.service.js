import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
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
import { sendNotification } from "../lib/telegram.js";

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

    // 3. Agent Wallets
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

    // 6. Persistent Infrastructure State
    this._sbProgram = null;
    this._sbQueue = null;
    this._lookupTable = null;
    this._isInitialized = false;
    this._initPromise = null;
    this._crankAta = null;

    // Ensure data directory exists for persistent files
    this.DATA_DIR = env.PERSISTENT_DATA_DIR || "./data";
    if (!fs.existsSync(this.DATA_DIR)) {
      fs.mkdirSync(this.DATA_DIR, { recursive: true });
    }

    // 7. Load or Generate Persistent Randomness Keypair
    const RNG_PATH = `${this.DATA_DIR}/rng-keypair.json`;
    if (fs.existsSync(RNG_PATH)) {
      this._rngKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(RNG_PATH, "utf8"))),
      );
      logger.info("Loaded existing RNG keypair", {
        pubkey: this._rngKeypair.publicKey.toBase58(),
      });
    } else {
      this._rngKeypair = Keypair.generate();
      fs.writeFileSync(
        RNG_PATH,
        JSON.stringify(Array.from(this._rngKeypair.secretKey)),
      );
      logger.info("Generated new RNG keypair", {
        pubkey: this._rngKeypair.publicKey.toBase58(),
      });
    }

    logger.info("Solana Service constructed", {
      crank: this.crankKeypair.publicKey.toBase58(),
      agentRed: this.agentRedKeypair.publicKey.toBase58(),
      agentBlue: this.agentBlueKeypair.publicKey.toBase58(),
      gameEngine: GAME_ENGINE_PROGRAM_ID.toBase58(),
      predMarket: PRED_MARKET_PROGRAM_ID.toBase58(),
    });
  }

  /**
   * Concurrency-safe initialization with error recovery.
   */
  async initialize() {
    if (this._isInitialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        await this._ensureSwitchboard();
        if (env.AUTO_TOKEN_ADDRESS) {
          try {
            await this._getCrankAta();
          } catch (ataErr) {
            logger.warn(
              "Crank ATA not ready (wallet may need SOL). Will retry on first use.",
              { error: ataErr.message },
            );
          }
        }
        await this._ensureLookupTable();

        this._isInitialized = true;
        logger.info(
          "SolanaService fully initialized with persistent infrastructure",
        );
      } catch (err) {
        this._initPromise = null; // Clear cached rejection to allow retries
        logger.error("Failed to initialize SolanaService infrastructure", {
          error: err.message,
        });
        throw err;
      }
    })();

    return this._initPromise;
  }

  getAgentKeypair(player) {
    return player === "RED" ? this.agentRedKeypair : this.agentBlueKeypair;
  }

  // ── Persistent Infrastructure Helpers ───────────────────────────

  async _ensureAta(mint, owner) {
    // Detect the token program that owns this mint
    const mintInfo = await this.connection.getAccountInfo(mint);

    // Fallback to legacy if null (though a valid mint shouldn't be null)
    const mintTokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;

    // --- NEW EXPLICIT CHECK ---
    const isToken2022 = mintTokenProgram.equals(TOKEN_2022_PROGRAM_ID);

    if (isToken2022) {
      logger.info("Token-2022 Mint detected", { mint: mint.toBase58() });
    } else {
      logger.info("Legacy SPL Token Mint detected", { mint: mint.toBase58() });
    }
    // --------------------------

    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      mintTokenProgram,
    );

    const info = await this.connection.getAccountInfo(ata);
    if (!info) {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        this.crankKeypair.publicKey,
        ata,
        owner,
        mint,
        mintTokenProgram, // This correctly routes to 2022 or Legacy
      );
      await this.provider.sendAndConfirm(
        new anchor.web3.Transaction().add(createAtaIx),
        [this.crankKeypair],
      );
      logger.info(
        `Persistent ATA created (${isToken2022 ? "Token-2022" : "Legacy"})`,
        { ata: ata.toBase58() },
      );
    }
    return ata;
  }

  async _getCrankAta() {
    if (this._crankAta) return this._crankAta;
    const autoMint = new PublicKey(env.AUTO_TOKEN_ADDRESS);
    this._crankAta = await this._ensureAta(
      autoMint,
      this.crankKeypair.publicKey,
    );
    return this._crankAta;
  }

  async _ensureLookupTable() {
    if (this._lookupTable) return this._lookupTable;

    const ALT_PATH = `${this.DATA_DIR}/lookup-table.json`;
    const requiredAddresses = [
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      GAME_ENGINE_PROGRAM_ID,
      PRED_MARKET_PROGRAM_ID,
      this._sbQueue?.pubkey,
      this._rngKeypair.publicKey,
    ].filter(Boolean);

    if (fs.existsSync(ALT_PATH)) {
      const { address } = JSON.parse(fs.readFileSync(ALT_PATH, "utf8"));
      const res = await this.connection.getAddressLookupTable(
        new PublicKey(address),
      );

      if (res.value) {
        this._lookupTable = res.value;

        // Check if all expected addresses are present
        const tableAddresses = res.value.state.addresses.map((a) =>
          a.toBase58(),
        );
        const missing = requiredAddresses.filter(
          (a) => !tableAddresses.includes(a.toBase58()),
        );

        if (missing.length > 0) {
          logger.warn("ALT missing addresses, extending...", {
            missing: missing.map((a) => a.toBase58()),
          });
          const extendIx = AddressLookupTableProgram.extendLookupTable({
            payer: this.crankKeypair.publicKey,
            authority: this.crankKeypair.publicKey,
            lookupTable: res.value.key,
            addresses: missing,
          });

          await this.provider.sendAndConfirm(
            new anchor.web3.Transaction().add(extendIx),
            [this.crankKeypair],
          );

          // Wait for extension to propagate, then reload table
          await new Promise((r) => setTimeout(r, 2000));
          const updatedRes = await this.connection.getAddressLookupTable(
            new PublicKey(address),
          );
          this._lookupTable = updatedRes.value;
        }

        logger.info("Loaded existing ALT", { address });
        return this._lookupTable;
      }
    }

    const slot = await this.connection.getSlot();
    const [createIx, tableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: this.crankKeypair.publicKey,
        payer: this.crankKeypair.publicKey,
        recentSlot: slot,
      });

    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: this.crankKeypair.publicKey,
      authority: this.crankKeypair.publicKey,
      lookupTable: tableAddress,
      addresses: requiredAddresses,
    });

    await this.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(createIx, extendIx),
      [this.crankKeypair],
    );

    await new Promise((r) => setTimeout(r, 2000));

    const tableRes = await this.connection.getAddressLookupTable(tableAddress);
    this._lookupTable = tableRes.value;

    fs.writeFileSync(
      ALT_PATH,
      JSON.stringify({ address: tableAddress.toBase58() }),
    );
    logger.info("Address lookup table created and saved", {
      tableAddress: tableAddress.toBase58(),
    });

    return this._lookupTable;
  }

  async _ensureSwitchboard() {
    if (this._sbProgram) return;

    this._sbProgram = await sb.AnchorUtils.loadProgramFromProvider(
      this.provider,
    );
    this._sbQueue = await sb.getDefaultQueue(this.connection.rpcEndpoint);

    logger.info("Switchboard initialized", {
      programId: this._sbProgram.programId.toBase58(),
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
      if (player === "RED") {
        gs.p1Stayed = true;
        if (!gs.p2Stayed) gs.activePlayer = { blue: {} };
      } else {
        gs.p2Stayed = true;
        if (!gs.p1Stayed) gs.activePlayer = { red: {} };
      }
      gs.phase =
        gs.p1Stayed && gs.p2Stayed
          ? { awaitingFinalRevealVrf: {} }
          : { awaitingAction: {} };
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
    if (env.MOCK_SOLANA) return this._generateMockTx();

    const [registryPda] = deriveRegistryPda();
    const [gamePda] = deriveGamePda(gameId);
    const crank = this.crankKeypair.publicKey;

    const currentState = await this.gameEngine.account.gameState.fetch(gamePda);
    const currentRound = currentState.roundNumber;

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
        { pubkey: roundMarketPda, isWritable: true, isSigner: false },
        { pubkey: mainMarketPda, isWritable: true, isSigner: false },
        { pubkey: PRED_MARKET_PROGRAM_ID, isWritable: false, isSigner: false },
      ])
      .rpc();

    logger.info("Round resolved", { gameId, txSig });
    return txSig;
  }

  // ── VRF Lifecycle ───────────────────────────────────────────────

  async vrfStep(gameId, rollType, agentColor) {
    if (env.MOCK_SOLANA)
      return this._mockVrfLogic(gameId, rollType, agentColor);

    await this.initialize();

    const [gamePda] = deriveGamePda(gameId);
    const [vrfRequestPda] = deriveVrfRequestPda(gameId);
    const crank = this.crankKeypair.publicKey;
    const microLamports = parseInt(
      env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS || "10000",
      10,
    );

    const isAgentSigned = rollType === 1 && agentColor;
    const signerKp = isAgentSigned
      ? this.getAgentKeypair(agentColor)
      : this.crankKeypair;

    let rngPubkey = this._rngKeypair.publicKey;
    const vrfReqInfo = await this.connection.getAccountInfo(vrfRequestPda);

    if (vrfReqInfo) {
      // 🚨 RECOVERY PATH: Trust the on-chain data over our local keypair
      const vrfReqData =
        await this.gameEngine.account.vrfRequest.fetch(vrfRequestPda);
      rngPubkey = vrfReqData.sbAccount;

      logger.info(
        "Recovered existing VRF request. Retrying reveal/fulfill...",
        { gameId, rollType, rngPubkey: rngPubkey.toBase58() },
      );
    } else {
      // 🟢 NORMAL COMMIT PATH
      const randomnessInfo = await this.connection.getAccountInfo(rngPubkey);
      const randomness = new sb.Randomness(this._sbProgram, rngPubkey);

      // 1. Create randomness account ON-CHAIN explicitly if it doesn't exist
      if (!randomnessInfo) {
        logger.info("Initializing persistent Randomness account on-chain...");
        const [_, createIx] = await sb.Randomness.create(
          this._sbProgram,
          this._rngKeypair,
          this._sbQueue.pubkey,
        );
        const createTx = new anchor.web3.Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
          createIx,
        );
        await this.provider.sendAndConfirm(createTx, [this._rngKeypair]);
        logger.info("Persistent Randomness account created successfully.");
      }

      // 2. Commit + Request VRF
      // Now safe to call commitIx because the account definitely exists
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

      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        commitIx,
        reqIx,
      ];

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: this.crankKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message([this._lookupTable]);

      const tx = new VersionedTransaction(message);

      const signers = [this.crankKeypair];
      if (isAgentSigned) signers.push(signerKp);

      tx.sign(signers);

      const commitSig = await this.connection.sendTransaction(tx);

      await this.connection.confirmTransaction(
        {
          signature: commitSig,
          blockhash,
          lastValidBlockHeight,
        },
        "confirmed",
      );
    }

    // Give Switchboard Oracle time to fulfill the randomness locally
    await this._sleep(VRF_SETTLE_DELAY_MS);

    // 🟢 REVEAL + FULFILL PATH
    const randomness = new sb.Randomness(this._sbProgram, rngPubkey);

    let revealIx;
    try {
      revealIx = await randomness.revealIx();
    } catch (error) {
      if (error.isAxiosError || error.name === "AxiosError") {
        try {
          const data = await randomness.loadData();
          const oracle = new sb.Oracle(this._sbProgram, data.oracle);
          const oracleData = await oracle.loadData();
          const gatewayUrl = String.fromCharCode(
            ...oracleData.gatewayUri,
          ).replace(/\0+$/, "");

          const errorDetails = {
            randomnessAccount: rngPubkey.toBase58(),
            seedSlot: data.seedSlot.toNumber(),
            oraclePubkey: data.oracle.toBase58(),
            gatewayUrl,
            status: error.response?.status,
            responseBody: error.response?.data,
            configUrl: error.config?.url,
            timestamp: new Date().toISOString(),
          };

          logger.error("Switchboard VRF Reveal Error details", errorDetails);
          error.message = `Switchboard VRF Reveal Error: ${error.message}\nDetails: ${JSON.stringify(errorDetails, null, 2)}`;
        } catch (innerErr) {
          logger.error(
            "Failed to load Switchboard metadata for error decoration",
            { err: innerErr.message },
          );
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

    const finalIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      revealIx,
      fillIx,
    ];

    if (rollType === 2 || rollType === 3) {
      const [registryPda] = deriveRegistryPda();
      const currentState =
        await this.gameEngine.account.gameState.fetch(gamePda);
      const currentRound = currentState.roundNumber;

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
          { pubkey: roundMarketPda, isWritable: true, isSigner: false },
          { pubkey: mainMarketPda, isWritable: true, isSigner: false },
          {
            pubkey: PRED_MARKET_PROGRAM_ID,
            isWritable: false,
            isSigner: false,
          },
        ])
        .instruction();

      finalIxs.push(resolveIx);
    }

    const { blockhash: revealBlockhash, lastValidBlockHeight: revealLbh } =
      await this.connection.getLatestBlockhash();
    const revealMsg = new TransactionMessage({
      payerKey: this.crankKeypair.publicKey,
      recentBlockhash: revealBlockhash,
      instructions: finalIxs,
    }).compileToV0Message([this._lookupTable]);

    const revealTx = new VersionedTransaction(revealMsg);
    revealTx.sign([this.crankKeypair]);

    const txSig = await this.connection.sendTransaction(revealTx);

    await this.connection.confirmTransaction(
      {
        signature: txSig,
        blockhash: revealBlockhash,
        lastValidBlockHeight: revealLbh,
      },
      "confirmed",
    );

    logger.info("VRF step complete", { gameId, rollType, agentColor, txSig });
    return txSig;
  }

  // ── Prediction Market ───────────────────────────────────────────

  async createOnChainMarket(gameId, marketIndex, question, expiresAtUnix) {
    if (env.MOCK_SOLANA) return this._generateMockTx();
    await this.initialize();

    const [marketPda] = deriveMarketPda(gameId, marketIndex);
    const [vaultPda] = deriveVaultPda(gameId, marketIndex);
    const crank = this.crankKeypair.publicKey;

    const creatorTokenAccount = await this._getCrankAta();

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
        autoMint: new PublicKey(env.AUTO_TOKEN_ADDRESS),
        creatorTokenAccount: creatorTokenAccount,
        authority: crank,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
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
    await this.initialize();

    const crank = this.crankKeypair.publicKey;
    const adminTokenAccount = await this._getCrankAta();

    const txSig = await this.predMarket.methods
      .withdrawLp()
      .accounts({
        market: new PublicKey(marketPdaAddress),
        vault: new PublicKey(vaultPdaAddress),
        adminTokenAccount: adminTokenAccount,
        mint: new PublicKey(env.AUTO_TOKEN_ADDRESS),
        authority: crank,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([this.crankKeypair])
      .rpc();

    logger.info("LP retrieved for market", { marketPdaAddress, txSig });
    return txSig;
  }

  async sweepUnclaimed(marketPdaAddress, vaultPdaAddress) {
    if (env.MOCK_SOLANA) return this._generateMockTx();
    await this.initialize();

    const marketInfo = await this.connection.getAccountInfo(
      new PublicKey(marketPdaAddress),
    );
    if (!marketInfo) {
      logger.warn("Market account already closed or missing", {
        marketPdaAddress,
      });
      return null;
    }

    const adminTokenAccount = await this._getCrankAta();

    const txSig = await this.predMarket.methods
      .sweepUnclaimed()
      .accounts({
        market: new PublicKey(marketPdaAddress),
        vault: new PublicKey(vaultPdaAddress),
        adminTokenAccount,
        mint: new PublicKey(env.AUTO_TOKEN_ADDRESS),
        authority: this.crankKeypair.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.crankKeypair])
      .rpc();

    logger.info("Market swept and closed, rent recovered", {
      marketPdaAddress,
      txSig,
    });

    return txSig;
  }

  async reclaimExpiredLp(marketPdaAddress, vaultPdaAddress) {
    if (env.MOCK_SOLANA) return this._generateMockTx();
    await this.initialize();

    const crank = this.crankKeypair.publicKey;
    const adminTokenAccount = await this._getCrankAta();

    const txSig = await this.predMarket.methods
      .reclaimExpiredLp()
      .accounts({
        market: new PublicKey(marketPdaAddress),
        vault: new PublicKey(vaultPdaAddress),
        adminTokenAccount: adminTokenAccount,
        mint: new PublicKey(env.AUTO_TOKEN_ADDRESS),
        authority: crank,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([this.crankKeypair])
      .rpc();

    logger.info("Expired LP safely reclaimed from dead market", {
      marketPdaAddress,
      txSig,
    });
    return txSig;
  }

  async rebalanceAgentWallets() {
    if (env.MOCK_SOLANA) {
      logger.info("Mock Solana enabled, skipping agent wallet rebalance");
      return;
    }
    const MIN_BALANCE = 0.05 * anchor.web3.LAMPORTS_PER_SOL;
    const TOP_UP_TO = 0.1 * anchor.web3.LAMPORTS_PER_SOL;

    for (const [name, kp] of [
      ["RED", this.agentRedKeypair],
      ["BLUE", this.agentBlueKeypair],
    ]) {
      try {
        const balance = await this.connection.getBalance(kp.publicKey);
        if (balance < MIN_BALANCE) {
          const topUp = TOP_UP_TO - balance;
          const crankBalance = await this.connection.getBalance(
            this.crankKeypair.publicKey,
          );
          const MIN_CRANK_BALANCE = 0.05 * anchor.web3.LAMPORTS_PER_SOL;

          if (crankBalance - topUp < MIN_CRANK_BALANCE) {
            logger.warn(
              `Crank has insufficient balance to top up agent ${name}`,
              {
                crankBalance: crankBalance / anchor.web3.LAMPORTS_PER_SOL,
                requiredTopUp: topUp / anchor.web3.LAMPORTS_PER_SOL,
              },
            );
            await sendNotification(
              `⚠️ <b>Agent Rebalance Alert</b>\n\n` +
                `Crank wallet has insufficient balance to top up agent ${name}.\n` +
                `- Crank balance: <code>${(crankBalance / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)}</code> SOL\n` +
                `- Required top up: <code>${(topUp / anchor.web3.LAMPORTS_PER_SOL).toFixed(6)}</code> SOL`,
            );
            continue;
          }

          const tx = new anchor.web3.Transaction().add(
            SystemProgram.transfer({
              fromPubkey: this.crankKeypair.publicKey,
              toPubkey: kp.publicKey,
              lamports: topUp,
            }),
          );

          const signature = await this.provider.sendAndConfirm(tx, [
            this.crankKeypair,
          ]);
          const topUpSol = topUp / anchor.web3.LAMPORTS_PER_SOL;
          const newBalanceSol = TOP_UP_TO / anchor.web3.LAMPORTS_PER_SOL;

          logger.info(`Topped up agent ${name}`, {
            topUpSol,
            newBalance: newBalanceSol,
            signature,
          });

          await sendNotification(
            `🤖 <b>Agent Rebalance</b>\n\n` +
              `Successfully topped up agent ${name} from Crank:\n` +
              `- <b>Top Up Amount:</b> <code>${topUpSol.toFixed(6)}</code> SOL\n` +
              `- <b>New Agent Balance:</b> <code>${newBalanceSol.toFixed(6)}</code> SOL\n` +
              `- <b>Tx Signature:</b> <code>${signature}</code>`,
          );
        }
      } catch (err) {
        logger.error(`Failed to rebalance agent wallet for ${name}`, {
          error: err.message,
        });
        await sendNotification(
          `❌ <b>Agent Rebalance Error</b>\n\n` +
            `Failed to top up agent ${name}:\n` +
            `<code>${err.message}</code>`,
        );
      }
    }
  }

  // ── Internal Helpers & Mock Simulation ──────────────────────────

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _generateMockTx() {
    return "mock_" + Math.random().toString(36).slice(2);
  }

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
        p1LastCard: 0,
        p2LastCard: 0,
        p1Stayed: false,
        p2Stayed: false,
        roundNumber: 1,
        phase: { awaitingInitialDeal: {} }, // Anchor enum struct match
        activePlayer: { red: {} },
        winner: null,
      };
    }
    return this._mockGames[gameId];
  }

  _mockActivePlayer(gs) {
    return (
      Object.keys(gs.activePlayer || { red: {} })[0]?.toUpperCase() || "RED"
    );
  }

  _resetMockRound(gs) {
    gs.p1Score = 0;
    gs.p2Score = 0;
    gs.p1Aces = 0;
    gs.p2Aces = 0;
    gs.p1Stayed = false;
    gs.p2Stayed = false;
    gs.activePlayer = { red: {} };
    gs.phase = { awaitingInitialDeal: {} };
  }

  _mockVrfLogic(gameId, rollType, agentColor) {
    const gs = this._getMockGameState(gameId);
    if (rollType === 0) {
      const p1CardValue = Math.floor(Math.random() * 10) + 1;
      const p2CardValue = Math.floor(Math.random() * 10) + 1;
      gs.p1LastCard = p1CardValue;
      gs.p2LastCard = p2CardValue;
      gs.p1Score = p1CardValue;
      gs.p2Score = p2CardValue;
      gs.p1Aces = p1CardValue === 1 ? 1 : 0;
      gs.p2Aces = p2CardValue === 1 ? 1 : 0;
      gs.p1Stayed = false;
      gs.p2Stayed = false;
      gs.activePlayer = { red: {} };
      gs.phase = { awaitingAction: {} };
    } else if (rollType === 1) {
      const activePlayer = this._mockActivePlayer(gs);
      if (agentColor && agentColor !== activePlayer)
        throw new Error("NotYourTurn");
      const cardVal = Math.floor(Math.random() * 10) + 1;
      if (activePlayer === "RED") {
        gs.p1Score += cardVal;
        gs.p1LastCard = cardVal;
      } else {
        gs.p2Score += cardVal;
        gs.p2LastCard = cardVal;
      }
      if (gs.p1Score >= 21) gs.p1Stayed = true;
      if (gs.p2Score >= 21) gs.p2Stayed = true;
      if (!(gs.p1Stayed && gs.p2Stayed)) {
        if (activePlayer === "RED" && !gs.p2Stayed)
          gs.activePlayer = { blue: {} };
        else if (activePlayer === "BLUE" && !gs.p1Stayed)
          gs.activePlayer = { red: {} };
      }
      gs.phase =
        gs.p1Stayed && gs.p2Stayed
          ? { awaitingFinalRevealVrf: {} }
          : { awaitingAction: {} };
    } else if (rollType === 2 || rollType === 3) {
      const p1CardValue = Math.floor(Math.random() * 10) + 1;
      const p2CardValue = Math.floor(Math.random() * 10) + 1;

      gs.p1LastCard = p1CardValue;
      gs.p2LastCard = p2CardValue;
      gs.p1Score += p1CardValue;
      gs.p2Score += p2CardValue;

      if (rollType === 2) {
        const p1Diff = Math.abs(gs.p1Score - 21);
        const p2Diff = Math.abs(gs.p2Score - 21);
        if (p1Diff === p2Diff) {
          gs.p1Score = 0;
          gs.p2Score = 0;
          gs.p1Aces = 0;
          gs.p2Aces = 0;
          gs.p1Stayed = false;
          gs.p2Stayed = false;
          gs.activePlayer = { red: {} };
          gs.phase = { awaitingTiebreakerVrf: {} };
          return this._generateMockTx();
        } else if (p1Diff < p2Diff) gs.p2Hp -= 1;
        else gs.p1Hp -= 1;
      } else {
        if (p1CardValue > p2CardValue) gs.p2Hp -= 1;
        else if (p2CardValue > p1CardValue) gs.p1Hp -= 1;
      }

      if (gs.p1Hp <= 0 || gs.p2Hp <= 0) {
        gs.phase = { ended: {} };
      } else if (rollType === 2 || p1CardValue !== p2CardValue) {
        gs.roundNumber += 1;
        this._resetMockRound(gs);
      } else {
        gs.p1Score = 0;
        gs.p2Score = 0;
        gs.p1Aces = 0;
        gs.p2Aces = 0;
        gs.p1Stayed = false;
        gs.p2Stayed = false;
        gs.activePlayer = { red: {} };
        gs.phase = { awaitingTiebreakerVrf: {} };
      }
    }
    return this._generateMockTx();
  }
}

export { ROLL_TYPE };
export const solanaService = new SolanaService();
