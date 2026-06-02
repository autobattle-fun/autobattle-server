import { solanaService } from "./src/services/solana.service.js";

async function main() {
  try {
    console.log("⏳ Initializing Solana Service infrastructure...");
    await solanaService.initialize();

    console.log("🚀 Firing initializeRegistry instruction to mainnet...");
    // 300 seconds (5 minutes) cooldown duration, matching your default
    const txSig = await solanaService.initializeRegistry(300);

    console.log("\n✅ Registry Initialized Successfully!");
    console.log(`🔗 Transaction Signature: https://solscan.io/tx/${txSig}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Failed to initialize registry:", error);
    process.exit(1);
  }
}

main();
