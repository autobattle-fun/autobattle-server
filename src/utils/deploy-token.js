import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "fs";

// 1. Setup Connection and Payer (Your Crank Wallet)
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// Load your local wallet (replace with process.env if running on a server)
const secretKeyString = fs.readFileSync(
  `${process.env.HOME}/.config/solana/id.json`,
  "utf8",
);
const secretKeyArray = Uint8Array.from(JSON.parse(secretKeyString));
const payer = Keypair.fromSecretKey(secretKeyArray);

// The wallet you want to send the unlimited tokens to
const TARGET_WALLET = new PublicKey(
  "Hp8tDsWE9EQpULMkqivZJSejMVDj3yRSD3K5AkCdA2J7",
);

// Token decimals (6 is standard for USDC/games)
const DECIMALS = 6;
// Amount to mint (1 Billion tokens per run)
const MINT_AMOUNT = 1_000_000_000 * 10 ** DECIMALS;

async function main() {
  console.log(`Payer Wallet: ${payer.publicKey.toBase58()}`);

  try {
    // 2. Create the Token Mint
    console.log("Deploying new SPL Token...");
    const mint = await createMint(
      connection,
      payer, // Payer for the transaction
      payer.publicKey, // Mint Authority (Who can create more)
      null, // Freeze Authority (Optional)
      DECIMALS, // Decimals
    );
    console.log(`✅ Token deployed! Mint Address: ${mint.toBase58()}`);

    // 3. Get or Create the Associated Token Account (ATA) for the Target Wallet
    console.log(
      `Setting up Token Account for target: ${TARGET_WALLET.toBase58()}`,
    );
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer, // Payer for the rent
      mint, // The token mint
      TARGET_WALLET, // The owner of the new token account
    );
    console.log(`✅ Target ATA: ${tokenAccount.address.toBase58()}`);

    // 4. Mint the Tokens
    console.log(`Minting ${MINT_AMOUNT / 10 ** DECIMALS} tokens to target...`);
    const txSig = await mintTo(
      connection,
      payer, // Payer
      mint, // Mint
      tokenAccount.address, // Destination
      payer.publicKey, // Mint Authority
      MINT_AMOUNT, // Amount
    );

    console.log(
      `✅ Success! View transaction: https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
    );
    console.log(`\nSave this Mint Address to your .env as AUTO_MINT_ADDRESS:`);
    console.log(mint.toBase58());
  } catch (error) {
    console.error("Error deploying or minting token:", error);
  }
}

main();
