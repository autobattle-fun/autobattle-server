import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  solanaService,
  PRED_MARKET_PROGRAM_ID,
} from "../services/solana.service.js";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import bs58 from "bs58";

async function getOpenfortFeePayer() {
  const res = await fetch("https://api.openfort.io/rpc/solana/devnet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENFORT_PROJECT_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getPayerSigner",
      params: [],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("Failed to fetch Openfort Fee Payer");
  return data.result.signer_address;
}

export async function getMyMarketSharesController(req, res) {
  const { marketId } = req.params;
  const userRecord = req.auth?.user;

  // 🔐 Security: Only let the authenticated user see their own shares
  if (!userRecord) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (!marketId) {
    return res.status(400).json({ success: false, error: "Missing marketId." });
  }

  try {
    // 1. Fetch the user's positions from your newly synced Database!
    const predictions = await prisma.prediction.findMany({
      where: {
        userId: userRecord.id,
        marketId: marketId,
      },
    });

    // 2. Format the data into a clean object for the frontend
    let yesShares = 0;
    let noShares = 0;
    let totalTokensSpent = 0;
    let hasClaimed = false;

    // Because of our @@unique([userId, marketId, side]) constraint,
    // this array will only ever have a maximum of 2 items (one YES, one NO)
    predictions.forEach((prediction) => {
      if (prediction.side === "YES") yesShares = Number(prediction.shareAmount);
      if (prediction.side === "NO") noShares = Number(prediction.shareAmount);

      totalTokensSpent += Number(prediction.amount);

      // If either side was claimed, mark the whole position as claimed
      if (prediction.hasClaimed) hasClaimed = true;
    });

    return res.status(200).json({
      success: true,
      data: {
        yesShares,
        noShares,
        totalTokensSpent, // Bonus: Now you can show them how much $AUTO they've invested!
        hasClaimed,
      },
    });
  } catch (error) {
    console.error("Fetch user shares error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

const AUTO_MINT_ADDRESS = new PublicKey(
  env.AUTO_TOKEN_ADDRESS || solanaService.crankKeypair.publicKey,
);

export async function buildTradeController(req, res) {
  // 🔐 Security: We no longer accept userPubkey from the body!
  const { marketId, side, amountTokens } = req.body;
  const userRecord = req.auth?.user;

  // Ensure the authenticated user has a linked wallet
  if (!userRecord || !userRecord.walletAddress) {
    return res.status(400).json({
      success: false,
      error: "User is not authenticated or has no linked wallet.",
    });
  }

  try {
    // 🔐 Security: Use the authenticated user's wallet address directly
    const user = new PublicKey(userRecord.walletAddress);
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

    const rawAmount = new BN(amountTokens * 1_000_000);
    const minSharesOut = new BN(1);
    const sideArg = side.toUpperCase() === "YES" ? { yes: {} } : { no: {} };

    const buyIx = await solanaService.predMarket.methods
      .buyShares(sideArg, rawAmount, minSharesOut)
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        user: user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const feePayerAddress = await getOpenfortFeePayer();

    const tx = new Transaction().add(buyIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = new PublicKey(feePayerAddress);

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
      feePayer: feePayerAddress,
    });
  } catch (error) {
    console.error("Build trade error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTradeController(req, res) {
  // 🔐 Security: userPubkey is removed from body.
  const { partiallySignedBase64, feePayer, marketId, side, amountTokens } =
    req.body;
  const userRecord = req.auth?.user;

  // Ensure the authenticated user has a linked wallet
  if (!userRecord || !userRecord.walletAddress) {
    return res.status(400).json({
      success: false,
      error: "User is not authenticated or has no linked wallet.",
    });
  }

  if (!partiallySignedBase64 || !feePayer || !marketId) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields." });
  }

  try {
    // Confirm using blockhash strategy
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // 1. Send to Openfort to Co-Sign (Pay Gas) and Broadcast
    const paymasterRes = await fetch(
      "https://api.openfort.io/rpc/solana/devnet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENFORT_PROJECT_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "signAndSendTransaction",
          params: {
            transaction: partiallySignedBase64,
            signer_key: feePayer,
            policy: env.OPENFORT_POLICY_ID,
          },
        }),
      },
    );

    const paymasterData = await paymasterRes.json();

    if (paymasterData.error) {
      console.error("Openfort Paymaster Error:", paymasterData.error);
      return res
        .status(400)
        .json({ success: false, error: "Paymaster failed." });
    }

    const signedTransaction = paymasterData.result?.signed_transaction;
    if (!signedTransaction) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid paymaster response." });
    }

    // Openfort already broadcast it — just extract the signature
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const decodedTx = Transaction.from(txBuffer);
    const signature = bs58.encode(decodedTx.signatures[0].signature);

    console.log(`[BLOCKCHAIN] Tx broadcasted by Openfort: ${signature}`);

    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      },
    );

    if (!txInfo || txInfo.meta?.err) {
      return res
        .status(400)
        .json({ success: false, error: "Transaction failed on-chain." });
    }

    const logs = txInfo.meta.logMessages || [];
    if (!logs.some((log) => log.includes(PRED_MARKET_PROGRAM_ID.toBase58()))) {
      return res.status(403).json({
        success: false,
        error: "Fraud alert: Invalid program interaction.",
      });
    }

    // 4. Fetch the absolute Source of Truth from the Blockchain
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    const userPk = new PublicKey(userRecord.walletAddress);
    const marketPda = new PublicKey(market.marketPda);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), userPk.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    // Fetch exact balances from the smart contract
    const onChainPosition = await solanaService.fetchUserPosition(
      positionPda.toBase58(),
    );

    // Divide by 1,000,000 to handle your 6 decimals
    const exactYesShares = onChainPosition.yesShares.toNumber() / 1_000_000;
    const exactNoShares = onChainPosition.noShares.toNumber() / 1_000_000;

    const exactSharesToSave =
      side.toUpperCase() === "YES" ? exactYesShares : exactNoShares;

    // 5. Upsert the Database to perfectly match the Blockchain
    const syncedPrediction = await prisma.prediction.upsert({
      where: {
        userId_marketId_side: {
          userId: userRecord.id,
          marketId: market.id,
          side: side.toUpperCase(),
        },
      },
      update: {
        shareAmount: exactSharesToSave,
        amount: { increment: amountTokens }, // Keep a running total of how many tokens they spent
      },
      create: {
        userId: userRecord.id,
        marketId: market.id,
        side: side.toUpperCase(),
        amount: amountTokens,
        shareAmount: exactSharesToSave,
        positionPda: positionPda.toBase58(),
        hasClaimed: false,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Trade sponsored, executed, and synced perfectly.",
      data: syncedPrediction,
    });
  } catch (error) {
    console.error("Execute trade error:", error);
    if (error.code === "P2002") {
      return res.status(400).json({
        success: false,
        error: "This prediction has already been logged.",
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildSellController(req, res) {
  // 🔐 Security: userPubkey is removed from body.
  const { marketId, side, amountShares } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  try {
    const user = new PublicKey(userRecord.walletAddress);
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
      solanaService.predMarket.programId, // Dynamic reference is safer
    );

    // Assuming shares use 6 decimals in your contract
    const rawAmount = new BN(Math.floor(amountShares * 1_000_000));
    const minTokensOut = new BN(1); // Slippage protection
    const sideArg = side.toUpperCase() === "YES" ? { yes: {} } : { no: {} };

    const sellIx = await solanaService.predMarket.methods
      .sellShares(sideArg, rawAmount, minTokensOut)
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        user: user,
        // Optional: you might need to pass the tokenProgram if your contract expects it
      })
      .instruction();

    const tx = new Transaction().add(sellIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    // ⛽️ GASLESS FIX: Make Openfort the fee payer!
    // Make sure OPENFORT_SPONSOR_KEY is set in your .env
    const feePayerAddress = await getOpenfortFeePayer();
    tx.feePayer = new PublicKey(feePayerAddress);

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
      feePayer: feePayerAddress, // Pass string back to frontend
    });
  } catch (error) {
    console.error("Build sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifySellController(req, res) {
  // 🔐 Notice we take partiallySignedBase64 and feePayer now
  const { partiallySignedBase64, feePayer, marketId, side } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (!partiallySignedBase64 || !feePayer || !marketId) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields." });
  }

  try {
    // Confirm using blockhash strategy
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // 1. Send to Openfort Paymaster for execution
    const paymasterRes = await fetch(
      "https://api.openfort.io/rpc/solana/devnet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENFORT_PROJECT_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "signAndSendTransaction",
          // 🚨 DONT FORGET: Add the policy ID here so Openfort allows it!
          params: {
            transaction: partiallySignedBase64,
            signer_key: feePayer,
            policy: env.OPENFORT_POLICY_ID,
          },
        }),
      },
    );

    const paymasterData = await paymasterRes.json();

    if (paymasterData.error) {
      console.error("Openfort Paymaster Error:", paymasterData.error);
      return res
        .status(400)
        .json({ success: false, error: "Paymaster failed." });
    }

    const signedTransaction = paymasterData.result?.signed_transaction;
    if (!signedTransaction) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid paymaster response." });
    }

    // Openfort already broadcast it — just extract the signature
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const decodedTx = Transaction.from(txBuffer);
    const signature = bs58.encode(decodedTx.signatures[0].signature);

    console.log(`[BLOCKCHAIN] Tx broadcasted by Openfort: ${signature}`);

    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    // 3. Security verification
    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );

    if (!txInfo || txInfo.meta?.err) {
      return res
        .status(400)
        .json({ success: false, error: "Transaction failed on-chain." });
    }

    const logs = txInfo.meta.logMessages || [];
    // Ensure the program was called (you can check specifically for SellShares if your contract logs it)
    if (
      !logs.some((log) =>
        log.includes(solanaService.predMarket.programId.toBase58()),
      )
    ) {
      return res
        .status(403)
        .json({ success: false, error: "Invalid contract interaction." });
    }

    // 4. Update the Database using the absolute Blockchain Truth
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    const userPk = new PublicKey(userRecord.walletAddress);
    const marketPda = new PublicKey(market.marketPda);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), userPk.toBuffer()],
      solanaService.predMarket.programId,
    );

    // Fetch the exact remaining shares from the contract
    const onChainPosition = await solanaService.fetchUserPosition(
      positionPda.toBase58(),
    );

    const exactYesShares = onChainPosition.yesShares.toNumber() / 1_000_000;
    const exactNoShares = onChainPosition.noShares.toNumber() / 1_000_000;

    // Clean up the side variable formatting just to be safe
    const dbSide =
      side.toUpperCase() === "RED"
        ? "YES"
        : side.toUpperCase() === "BLUE"
          ? "NO"
          : side.toUpperCase();
    const exactSharesLeftToSave =
      dbSide === "YES" ? exactYesShares : exactNoShares;

    // 5. Sync the DB!
    await prisma.prediction.updateMany({
      where: {
        userId: userRecord.id,
        marketId: market.id,
        side: dbSide,
      },
      data: {
        shareAmount: exactSharesLeftToSave,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Sell sponsored, executed, and synced perfectly.",
    });
  } catch (error) {
    console.error("Verify sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildTransferController(req, res) {
  // 🔐 Security: Sender is strictly pulled from the auth token
  const { recipientAddress, amountTokens } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  if (!recipientAddress || !amountTokens) {
    return res
      .status(400)
      .json({ success: false, error: "Missing recipient or amount." });
  }

  try {
    const sender = new PublicKey(userRecord.walletAddress);
    const recipient = new PublicKey(recipientAddress);

    const senderAta = getAssociatedTokenAddressSync(AUTO_MINT_ADDRESS, sender);
    const recipientAta = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      recipient,
    );

    const tx = new Transaction();
    const feePayerAddress = await getOpenfortFeePayer();
    const feePayerKey = new PublicKey(feePayerAddress);

    // 1. 🛡️ The ATA Check: Does the recipient have an account to hold $AUTO?
    const recipientAtaInfo =
      await solanaService.connection.getAccountInfo(recipientAta);

    if (!recipientAtaInfo) {
      console.log(`Creating ATA for recipient ${recipientAddress}...`);
      // Openfort pays the rent for the new user's token account!
      tx.add(
        createAssociatedTokenAccountInstruction(
          feePayerKey, // Payer
          recipientAta, // Associated Token Account
          recipient, // Owner
          AUTO_MINT_ADDRESS, // Mint
        ),
      );
    }

    // 2. The Transfer Instruction (Assuming 6 decimals)
    // Note: createTransferInstruction expects a BigInt or Number depending on your spl-token version
    const rawAmount = Math.floor(amountTokens * 1_000_000);

    tx.add(
      createTransferInstruction(
        senderAta, // Source
        recipientAta, // Destination
        sender, // Owner of Source
        rawAmount, // Amount
      ),
    );

    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayerKey;

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
      feePayer: feePayerAddress,
    });
  } catch (error) {
    console.error("Build transfer error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTransferController(req, res) {
  const { partiallySignedBase64, feePayer } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (!partiallySignedBase64 || !feePayer) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields." });
  }

  try {
    // Confirm with blockhash strategy
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // 1. Send to Openfort Paymaster to sponsor the transfer (and potential ATA rent)
    const paymasterRes = await fetch(
      "https://api.openfort.io/rpc/solana/devnet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENFORT_PROJECT_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "signAndSendTransaction",
          params: {
            transaction: partiallySignedBase64,
            signer_key: feePayer,
            policy: env.OPENFORT_POLICY_ID,
          },
        }),
      },
    );

    const paymasterData = await paymasterRes.json();

    if (paymasterData.error) {
      console.error("Openfort Paymaster Error:", paymasterData.error);
      return res
        .status(400)
        .json({ success: false, error: "Failed to sponsor transfer." });
    }

    const signedTransaction = paymasterData.result?.signed_transaction;

    if (!signedTransaction) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid paymaster response." });
    }

    // Decode and send the fully signed transaction to Solana directly
    // ✅ Extract the signature from the already-broadcast signed transaction
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const decodedTx = Transaction.from(txBuffer);
    const signature = bs58.encode(decodedTx.signatures[0].signature);

    console.log(`[BLOCKCHAIN] Transfer broadcasted: ${signature}`);

    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // 3. Security verification (Optional but recommended)
    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );

    if (!txInfo || txInfo.meta?.err) {
      return res
        .status(400)
        .json({ success: false, error: "Transfer failed on-chain." });
    }

    // You don't necessarily have to update the database for a transfer unless you are
    // strictly tracking global wallet balances in Prisma outside of predictions.

    return res.status(200).json({
      success: true,
      message: "Transfer successfully sponsored and executed.",
      signature: signature,
    });
  } catch (error) {
    console.error("Verify transfer error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildClaimController(req, res) {
  // 🔐 Security: Removed userPubkey from the request body
  const { marketId } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  if (!marketId) {
    return res.status(400).json({ success: false, error: "Missing marketId" });
  }

  try {
    const user = new PublicKey(userRecord.walletAddress);
    const market = await prisma.market.findUnique({ where: { id: marketId } });

    if (!market)
      return res
        .status(404)
        .json({ success: false, error: "Market not found." });

    if (market.status !== "RESOLVED")
      return res.status(400).json({
        success: false,
        error: "Cannot claim yet. Market is still OPEN.",
      });

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);

    // Using your global constant defined at the top of the file
    const userTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      user,
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

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

    const tx = new Transaction().add(claimIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    // ⛽️ GASLESS FIX: Make Openfort the fee payer!
    const feePayerAddress = await getOpenfortFeePayer();
    tx.feePayer = new PublicKey(feePayerAddress);

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
      feePayer: feePayerAddress, // Pass string back to frontend
    });
  } catch (error) {
    console.error("Build claim error:", error);
    if (error.message.includes("Account does not exist"))
      return res.status(400).json({
        success: false,
        error: "No winning position found for this wallet, or already claimed.",
      });
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyClaimController(req, res) {
  // 🔐 Now expecting partiallySignedBase64 and feePayer instead of a final signature
  const { partiallySignedBase64, feePayer, marketId } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (!partiallySignedBase64 || !feePayer || !marketId) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields." });
  }

  try {
    // Confirm using blockhash strategy
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // 1. Send to Openfort Paymaster for execution
    const paymasterRes = await fetch(
      "https://api.openfort.io/rpc/solana/devnet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENFORT_PROJECT_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "signAndSendTransaction",
          // 🚨 Includes your exact policy config
          params: {
            transaction: partiallySignedBase64,
            signer_key: feePayer,
            policy: env.OPENFORT_POLICY_ID,
          },
        }),
      },
    );
    const paymasterData = await paymasterRes.json();

    if (paymasterData.error) {
      console.error("Openfort Paymaster Error:", paymasterData.error);
      return res
        .status(400)
        .json({ success: false, error: "Paymaster failed." });
    }

    const signedTransaction = paymasterData.result?.signed_transaction;
    if (!signedTransaction) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid paymaster response." });
    }

    // Openfort already broadcast it — just extract the signature
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const decodedTx = Transaction.from(txBuffer);
    const signature = bs58.encode(decodedTx.signatures[0].signature);

    console.log(`[BLOCKCHAIN] Tx broadcasted by Openfort: ${signature}`);

    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // 3. Security verification
    const txInfo = await solanaService.connection.getParsedTransaction(
      signature,
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );

    if (!txInfo || txInfo.meta?.err) {
      return res
        .status(400)
        .json({ success: false, error: "Claim transaction failed on-chain." });
    }

    const logs = txInfo?.meta?.logMessages || [];

    // Verify it interacted with your specific program
    if (!logs.some((log) => log.includes(PRED_MARKET_PROGRAM_ID.toBase58()))) {
      return res.status(403).json({
        success: false,
        error: "Fraud alert: Invalid program interaction.",
      });
    }

    // 4. Update the database securely using the authenticated user ID
    const updatedPrediction = await prisma.prediction.updateMany({
      where: {
        marketId: marketId,
        userId: userRecord.id, // 🔐 Replaced wallet lookup with exact user ID
        hasClaimed: false,
      },
      data: { hasClaimed: true },
    });

    if (updatedPrediction.count === 0)
      return res.status(404).json({
        success: false,
        message:
          "No pending prediction found to update. It might already be marked as claimed.",
      });

    return res.status(200).json({
      success: true,
      message: "Claim successfully sponsored, verified, and database updated.",
    });
  } catch (error) {
    console.error("Verify claim error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function retrieveLpController(req, res) {
  const marketId = req.params.marketId;

  try {
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "RESOLVED")
      return res.status(400).json({
        success: false,
        error: "Market must be resolved to retrieve LP.",
      });

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const crank = solanaService.crankKeypair;
    const creatorTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      crank.publicKey,
    );

    const txSig = await solanaService.predMarket.methods
      .withdrawLp()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        adminTokenAccount: creatorTokenAccount,
        authority: crank.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([crank])
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
