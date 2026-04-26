import { PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { solanaService, PRED_MARKET_PROGRAM_ID } from "../services/solana.service.js";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";

const AUTO_MINT_ADDRESS = new PublicKey(env.AUTO_TOKEN_ADDRESS || solanaService.crankKeypair.publicKey);

export async function buildTradeController(req, res) {
  const { userPubkey, marketId, side, amountTokens } = req.body;

  try {
    const user = new PublicKey(userPubkey);

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "OPEN") {
      return res.status(400).json({ success: false, error: "Market not found or closed." });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const userTokenAccount = getAssociatedTokenAddressSync(AUTO_MINT_ADDRESS, user);

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

    const tx = new Transaction().add(buyIx);
    const { blockhash } = await solanaService.connection.getLatestBlockhash("finalized");
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
    console.error("Build trade error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTradeController(req, res) {
  const { signature, marketId, userPubkey, side, amountTokens } = req.body;

  if (!signature || !marketId || !userPubkey) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  try {
    const txInfo = await solanaService.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!txInfo) return res.status(404).json({ success: false, error: "Transaction not found on network." });
    if (txInfo.meta?.err) return res.status(400).json({ success: false, error: "Transaction failed on-chain." });

    const logs = txInfo.meta.logMessages || [];
    const calledYourProgram = logs.some((log) => log.includes(PRED_MARKET_PROGRAM_ID.toBase58()));

    if (!calledYourProgram) {
      return res.status(403).json({ success: false, error: "Fraud alert: This transaction did not interact with the Prediction Market." });
    }

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market) return res.status(404).json({ success: false, error: "Market not found in database." });

    const userPk = new PublicKey(userPubkey);
    const marketPda = new PublicKey(market.marketPda);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), userPk.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    try {
      await solanaService.fetchUserPosition(positionPda.toBase58());
    } catch (e) {
      return res.status(403).json({ success: false, error: "Fraud alert: No on-chain position found for this wallet. Trade was faked." });
    }

    const userRecord = await prisma.user.upsert({
      where: { privyUserId: userPubkey },
      update: {},
      create: { privyUserId: userPubkey, username: `user_${userPubkey.slice(0, 6)}`, walletAddress: userPubkey },
    });

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

    return res.status(200).json({ success: true, message: "Trade strictly verified and recorded.", data: newPrediction });
  } catch (error) {
    console.error("Verify trade error:", error);
    if (error.code === "P2002") return res.status(400).json({ success: false, error: "This prediction has already been logged." });
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildSellController(req, res) {
  const { userPubkey, marketId, side, amountShares } = req.body;

  try {
    const user = new PublicKey(userPubkey);
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    
    if (!market || market.status !== "OPEN") {
      return res.status(400).json({ success: false, error: "Market not found or closed." });
    }

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const userTokenAccount = getAssociatedTokenAddressSync(AUTO_MINT_ADDRESS, user);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    const rawAmount = new BN(Math.floor(amountShares * 1_000_000));
    const minTokensOut = new BN(1);
    const sideArg = side.toUpperCase() === "YES" ? { yes: {} } : { no: {} };

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
    const { blockhash } = await solanaService.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return res.status(200).json({ success: true, transaction: serializedTx.toString("base64") });
  } catch (error) {
    console.error("Build sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifySellController(req, res) {
  const { signature, marketId, userPubkey, side, amountShares } = req.body;

  try {
    const status = await solanaService.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (!status?.value || status.value.err) return res.status(400).json({ success: false, error: "Transaction failed or not found." });

    const txInfo = await solanaService.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = txInfo?.meta?.logMessages || [];

    if (!logs.some((log) => log.includes("Instruction: SellShares"))) {
      return res.status(403).json({ success: false, error: "Not a valid sell transaction." });
    }

    const market = await prisma.market.findUnique({ where: { id: marketId } });
    let dbSide = side.toUpperCase() === "RED" ? "YES" : side.toUpperCase() === "BLUE" ? "NO" : side.toUpperCase();

    const userRecord = await prisma.user.findUnique({ where: { privyUserId: userPubkey } });
    if (!userRecord) return res.status(404).json({ success: false, error: "User not found." });

    await prisma.prediction.updateMany({
      where: { userId: userRecord.id, marketId: market.id, side: dbSide },
      data: { amount: { decrement: amountShares } },
    });

    return res.status(200).json({ success: true, message: "Sell successfully verified and recorded." });
  } catch (error) {
    console.error("Verify sell error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildClaimController(req, res) {
  const { userPubkey, marketId } = req.body;
  if (!userPubkey || !marketId) return res.status(400).json({ success: false, error: "Missing userPubkey or marketId" });

  try {
    const user = new PublicKey(userPubkey);
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    
    if (!market) return res.status(404).json({ success: false, error: "Market not found." });
    if (market.status !== "RESOLVED") return res.status(400).json({ success: false, error: "Cannot claim yet. Market is still OPEN." });

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const userTokenAccount = getAssociatedTokenAddressSync(AUTO_MINT_ADDRESS, user);

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
    const { blockhash } = await solanaService.connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return res.status(200).json({ success: true, transaction: serializedTx.toString("base64") });
  } catch (error) {
    console.error("Build claim error:", error);
    if (error.message.includes("Account does not exist")) return res.status(400).json({ success: false, error: "No winning position found for this wallet, or already claimed." });
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyClaimController(req, res) {
  const { signature, marketId, userPubkey } = req.body;
  if (!signature || !marketId || !userPubkey) return res.status(400).json({ success: false, error: "Missing required fields." });

  try {
    const status = await solanaService.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (!status || !status.value) return res.status(404).json({ success: false, error: "Claim transaction not found." });
    if (status.value.err) return res.status(400).json({ success: false, error: "Claim transaction failed on-chain." });

    const txInfo = await solanaService.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = txInfo?.meta?.logMessages || [];

    if (!logs.some((log) => log.includes("Instruction: ClaimPayout"))) {
      return res.status(403).json({ success: false, error: "This signature is not for a claim instruction." });
    }

    const updatedPrediction = await prisma.prediction.updateMany({
      where: { marketId: marketId, user: { walletAddress: userPubkey }, hasClaimed: false },
      data: { hasClaimed: true },
    });

    if (updatedPrediction.count === 0) return res.status(404).json({ success: false, message: "No pending prediction found to update. It might already be marked as claimed." });

    return res.status(200).json({ success: true, message: "Claim successfully verified and database updated." });
  } catch (error) {
    console.error("Verify claim error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function retrieveLpController(req, res) {
  const marketId = req.params.marketId;

  try {
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    if (!market || market.status !== "RESOLVED") return res.status(400).json({ success: false, error: "Market must be resolved to retrieve LP." });

    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const crank = solanaService.crankKeypair;
    const creatorTokenAccount = getAssociatedTokenAddressSync(AUTO_MINT_ADDRESS, crank.publicKey);

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

    return res.status(200).json({ success: true, message: `LP successfully retrieved for market ${market.slug}`, txSig: txSig });
  } catch (error) {
    console.error("Retrieve LP error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
