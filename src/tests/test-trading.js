import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction
} from "@solana/spl-token";
import { solanaService, PRED_MARKET_PROGRAM_ID } from "../services/solana.service.js";
import { startMatch, playRound } from "../services/game.service.js";
import { prisma } from "../db/prisma.js";
import { buildTradeController, verifyTradeController, buildClaimController, verifyClaimController } from "../controllers/trade.controller.js";
import { env } from "../config/env.js";

const AUTO_MINT = new PublicKey(env.AUTO_TOKEN_ADDRESS);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fundTestWallet(testUser) {
  console.log(`[SETUP] Funding test wallet: ${testUser.publicKey.toBase58()}`);

  const crank = solanaService.crankKeypair;
  const userPubkey = testUser.publicKey;

  // 1. Transfer SOL for gas
  const solTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: crank.publicKey,
      toPubkey: userPubkey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    })
  );

  await solanaService.provider.sendAndConfirm(solTx, [crank]);
  console.log(`[SETUP] Transferred 0.1 SOL to user.`);

  // 2. Setup AUTO token account for user
  const userAta = getAssociatedTokenAddressSync(AUTO_MINT, userPubkey);
  const crankAta = getAssociatedTokenAddressSync(AUTO_MINT, crank.publicKey);

  const ataTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      crank.publicKey,
      userAta,
      userPubkey,
      AUTO_MINT
    )
  );

  try {
    await solanaService.provider.sendAndConfirm(ataTx, [crank]);
    console.log(`[SETUP] Created AUTO ATA for user.`);
  } catch (e) {
    console.log(`[SETUP] ATA already exists or error: ${e.message}`);
  }

  // 3. Transfer AUTO tokens for trading (1000 tokens)
  const transferTx = new Transaction().add(
    createTransferInstruction(
      crankAta,
      userAta,
      crank.publicKey,
      1000 * 1_000_000 // 1000 tokens with 6 decimals
    )
  );

  await solanaService.provider.sendAndConfirm(transferTx, [crank]);
  console.log(`[SETUP] Transferred 1000 AUTO to user.`);
}

async function runTradeTest() {
  try {
    const testUser = Keypair.generate();
    await fundTestWallet(testUser);

    console.log("--- Starting Match Simulation ---");
    const { match, mainMarket } = await startMatch();
    console.log(`Match started: ${match.id}, Main Market: ${mainMarket.id}`);

    // --- TEST 1: Buy YES on Main Market ---
    console.log(`\n[TRADE] Simulating Buy YES on Main Market...`);
    const amount = 10;

    // Call buildTradeController logic (simulated request)
    const buildReq = { body: { userPubkey: testUser.publicKey.toBase58(), marketId: mainMarket.id, side: "YES", amountTokens: amount } };
    const buildRes = { status: (code) => ({ json: (data) => ({ code, data }) }) };
    const buildResult = await buildTradeController(buildReq, buildRes);

    if (buildResult.code !== 200) throw new Error(`Build trade failed: ${buildResult.data.error}`);

    const tx = Transaction.from(Buffer.from(buildResult.data.transaction, "base64"));
    tx.partialSign(testUser);

    const signature = await solanaService.connection.sendRawTransaction(tx.serialize());
    console.log(`[TRADE] Transaction sent: ${signature}`);
    await solanaService.connection.confirmTransaction(signature, "confirmed");
    console.log(`[TRADE] Transaction confirmed.`);

    // Verify trade via backend controller
    const verifyReq = { body: { signature, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58(), side: "YES", amountTokens: amount } };
    const verifyRes = { status: (code) => ({ json: (data) => ({ code, data }) }) };
    const verifyResult = await verifyTradeController(verifyReq, verifyRes);

    if (verifyResult.code !== 200) throw new Error(`Verify trade failed: ${verifyResult.data.error}`);
    console.log(`[TRADE] Trade verified and recorded:`, verifyResult.data.data.id);

    // --- ADVANCE GAME ---
    console.log(`\n[GAME] Playing Round 1...`);
    await playRound(match.id);

    const updatedMatch = await prisma.match.findUnique({ where: { id: match.id } });
    console.log(`[GAME] Round 1 complete. Red HP: ${updatedMatch.redHp}, Blue HP: ${updatedMatch.blueHp}`);

    // --- TEST 2: Buy NO during game ---
    console.log(`\n[TRADE] Simulating Buy NO on Main Market...`);
    const buildReq2 = { body: { userPubkey: testUser.publicKey.toBase58(), marketId: mainMarket.id, side: "NO", amountTokens: 5 } };
    const buildResult2 = await buildTradeController(buildReq2, buildRes);

    const tx2 = Transaction.from(Buffer.from(buildResult2.data.transaction, "base64"));
    tx2.partialSign(testUser);
    const signature2 = await solanaService.connection.sendRawTransaction(tx2.serialize());
    await solanaService.connection.confirmTransaction(signature2, "confirmed");

    const verifyReq2 = { body: { signature: signature2, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58(), side: "NO", amountTokens: 5 } };
    const verifyResult2 = await verifyTradeController(verifyReq2, verifyRes);
    console.log(`[TRADE] Second trade verified:`, verifyResult2.data.data.id);

    // --- FINISH GAME ---
    console.log(`\n[GAME] Finishing match...`);
    let finalMatch = updatedMatch;
    while (finalMatch.status !== "RESOLVED") {
      const res = await playRound(match.id);
      finalMatch = res.match;
      console.log(`[GAME] Round ${finalMatch.roundNumber} resolved. Winner: ${finalMatch.winner || "None yet"}`);
    }

    const resolvedMarket = await prisma.market.findFirst({ where: { matchId: match.id, marketType: "MAIN" } });
    console.log(`\n[MARKET] Resolved! Winner side: ${resolvedMarket.winningOutcome}`);

    // --- TEST 3: Claim Payout ---
    if (resolvedMarket.winningOutcome) {
      console.log(`\n[CLAIM] Simulating Claim Payout...`);
      const claimReq = { body: { userPubkey: testUser.publicKey.toBase58(), marketId: mainMarket.id } };
      const claimRes = { status: (code) => ({ json: (data) => ({ code, data }) }) };
      const claimBuildResult = await buildClaimController(claimReq, claimRes);

      if (claimBuildResult.code === 200) {
        const claimTx = Transaction.from(Buffer.from(claimBuildResult.data.transaction, "base64"));
        claimTx.partialSign(testUser);
        const claimSig = await solanaService.connection.sendRawTransaction(claimTx.serialize());
        await solanaService.connection.confirmTransaction(claimSig, "confirmed");
        console.log(`[CLAIM] Claim transaction confirmed: ${claimSig}`);

        const verifyClaimReq = { body: { signature: claimSig, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58() } };
        const verifyClaimResult = await verifyClaimController(verifyClaimReq, verifyRes);
        console.log(`[CLAIM] Claim verified and database updated:`, verifyClaimResult.data.message);
      } else {
        console.log(`[CLAIM] Build claim failed (User might have lost):`, claimBuildResult.data.error);
      }
    }

    console.log(`\n--- ALL TESTS COMPLETE ---`);
    process.exit(0);
  } catch (error) {
    console.error(`\n[ERROR] Test failed:`, error);
    process.exit(1);
  }
}

runTradeTest();
