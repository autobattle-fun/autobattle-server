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
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMI+c4zzHsPmmNG+1f3bIAwUBYi+a95uwAVVyKPOGcVu8xZKITHUS4pxuUA7DabtxB8+KRAH07C78S05wD+KKr1ZW3PJbsdKnqLZHD9FNumszsBNTGB0OupwF782be/pKQhr5LH4H1LJaP+PGjCSYleSEKA4MRaUvQ4pe5516uJnnoN+GNrUCHIDc//0psOIK8crccj+xgX39YM16xtyjzZ2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA70qFdIPWsnjJOinQiG5qWNIhD54s1iVgKW8ODFmUDaoG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqTKwvWua5L+ri7VeS0kdIx+af1POmPRDNra+c1rS5iJeAQYHAwEEAgAHBQh/8IQ+48aShQ==";

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
