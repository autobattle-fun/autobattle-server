import { Connection, Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

// 1. Setup Connection (Use your devnet/localnet URL)
const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");

async function executeTrade() {
  try {
    // 2. Paste the exact base64 string from your API response
    const base64Tx =
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAIH+c4zzHsPmmNG+1f3bIAwUBYi+a95uwAVVyKPOGcVu8xFvBNjR3NMCH5+ZsCoC5YtMPdfuof8MTVHMvcZbvjHK23PJbsdKnqLZHD9FNumszsBNTGB0OupwF782be/pKQhunAv9lM0E7vI1r/9dAa83yDR7Bp3qw2JxE0njB9pRT7GgYatCA2KZGW49ECNUW7jZH0KRUrcOMrBYKEG8oy71O9KhXSD1rJ4yTop0IhualjSIQ+eLNYlYClvDgxZlA2qBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKm5kmQCz2rRjUjndpIFFR7bFtByS8/OSvD6WJZZyrdIgQEFBgEDBAIABhm4pKkQ557HxABRtloAAAAAAAEAAAAAAAAA";

    // 3. Decode the base64 string back into a Solana Transaction object
    const txBuffer = Buffer.from(base64Tx, "base64");
    const tx = Transaction.from(txBuffer);

    // 4. Load the User's Private Key
    // WARNING: This MUST belong to the `userPubkey` you sent in the POST request!
    // If you used your crank or agent wallet for testing, paste its private key here.
    const userPrivateKeyString = process.env.TEST_USER_PRIVATE_KEY;

    let userKeypair;
    try {
      // If your key is base58 encoded (like phantom exports)
      userKeypair = Keypair.fromSecretKey(bs58.decode(userPrivateKeyString));
    } catch {
      // If your key is a JSON array (like solana CLI exports)
      const secretKeyArray = Uint8Array.from(JSON.parse(userPrivateKeyString));
      userKeypair = Keypair.fromSecretKey(secretKeyArray);
    }

    console.log(
      `Signing transaction for wallet: ${userKeypair.publicKey.toBase58()}`,
    );

    // 5. Sign the transaction
    tx.sign(userKeypair);

    // 6. Send the raw transaction to the blockchain
    console.log("Sending transaction to network...");
    const signature = await connection.sendRawTransaction(tx.serialize());

    console.log(`Transaction sent! Signature: ${signature}`);

    // 7. Wait for confirmation
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: signature,
    });

    console.log("Transaction officially confirmed on-chain! 🎉");
  } catch (error) {
    console.error("Execution failed:", error);
  }
}

executeTrade();
