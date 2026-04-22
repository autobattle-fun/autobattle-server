import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";

// Load IDLs (Using ES Modules requires parsing JSON directly)
const gameEngineIdl = JSON.parse(
  fs.readFileSync(new URL("../idls/game_engine.json", import.meta.url)),
);
const predMarketIdl = JSON.parse(
  fs.readFileSync(new URL("../idls/prediction_market.json", import.meta.url)),
);

// Contract Addresses
export const GAME_ENGINE_PROGRAM_ID = new PublicKey(
  gameEngineIdl.metadata.address,
);
export const PRED_MARKET_PROGRAM_ID = new PublicKey(
  predMarketIdl.metadata.address,
);

class SolanaService {
  constructor() {
    // 1. Setup Connection
    this.connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");

    // 2. Setup the Server's Wallet (The Crank)
    const secretKeyString = process.env.CRANK_PRIVATE_KEY;
    if (!secretKeyString)
      throw new Error("CRANK_PRIVATE_KEY is missing in .env");

    const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyString));
    this.crankKeypair = Keypair.fromSecretKey(secretKeyArray);

    this.wallet = new anchor.Wallet(this.crankKeypair);

    // 3. Setup Anchor Provider
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      preflightCommitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    // 4. Initialize Programs
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

    console.log(
      `✅ Solana Service Initialized. Crank Wallet: ${this.crankKeypair.publicKey.toBase58()}`,
    );
  }

  // --- Helper Methods Example ---

  async fetchGameState(gamePdaAddress) {
    return await this.gameEngine.account.gameState.fetch(
      new PublicKey(gamePdaAddress),
    );
  }

  async resolveMatch(gamePda, marketPda, registryPda) {
    // This allows your API routes to trigger on-chain actions
    return await this.gameEngine.methods
      .resolveRound()
      .accounts({
        registry: new PublicKey(registryPda),
        gameState: new PublicKey(gamePda),
        crank: this.crankKeypair.publicKey,
      })
      .remainingAccounts([
        { pubkey: new PublicKey(marketPda), isWritable: true, isSigner: false },
        { pubkey: PRED_MARKET_PROGRAM_ID, isWritable: false, isSigner: false },
      ])
      .rpc();
  }
}

export const solanaService = new SolanaService();
