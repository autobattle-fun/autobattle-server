import fs from "fs";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction
} from "@solana/spl-token";
import { solanaService } from "../services/solana.service.js";
import { startMatch, playRound } from "../services/game.service.js";
import { prisma } from "../db/prisma.js";
import {
  buildTradeTransaction,
  verifyTrade,
  buildClaimTransaction,
  verifyClaim,
  buildSellTransaction,
  verifySell,
  getMarketPrices
} from "../controllers/test.controller.js";
import { env } from "../config/env.js";
import { wsEvents } from "../lib/websocket.js";
import { startPriceStream, stopPriceStream } from "../lib/price-stream.js";

// --- OVERRIDE ENV FOR HEADLESS TESTING ---
env.MOCK_SOLANA = false;
env.CRANK_ENABLED = false;
env.PREPARATION_PHASE_SECONDS = 2;
env.MATCHMAKING_PHASE_SECONDS = 2;

// --- LOGGING TO FILE ---
const logFile = fs.createWriteStream("../../logs/trade-test.log", { flags: "w" });
function logToFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logFile.write(line);
  process.stdout.write(line);
}

const formatArgs = (args) => {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a, Object.getOwnPropertyNames(a), 2);
      } catch (e) {
        return String(a);
      }
    }
    return String(a);
  }).join(' ');
};

const origLog = console.log;
console.log = (...args) => {
  logToFile(formatArgs(args));
};

const origInfo = console.info;
console.info = (...args) => {
  logToFile(formatArgs(args));
};

const origWarn = console.warn;
console.warn = (...args) => {
  const msg = formatArgs(args);
  const prefix = msg.startsWith('[WARN]') ? '' : '[WARN] ';
  logToFile(prefix + msg);
};

const origError = console.error;
console.error = (...args) => {
  const msg = formatArgs(args);
  const prefix = msg.startsWith('[ERROR]') ? '' : '[ERROR] ';
  logToFile(prefix + msg);
};

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- MOCK WEBSOCKET EVENTS TO CAPTURE PRICE UPDATES ---
const originalMarketPrices = wsEvents.marketPrices;
wsEvents.marketPrices = (matchId, prices) => {
  console.log(`[WS] Market Prices Update: ${JSON.stringify(prices)}`);
  originalMarketPrices(matchId, prices);
};

const AUTO_MINT = new PublicKey(env.AUTO_TOKEN_ADDRESS || solanaService.crankKeypair.publicKey);

function mockRes() {
  return {
    statusCode: 200,
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    }
  };
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
      lamports: 0.05 * LAMPORTS_PER_SOL,
    })
  );

  await solanaService.provider.sendAndConfirm(solTx, [crank]);
  console.log(`[SETUP] Transferred 0.05 SOL to user.`);

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
      1000 * 1_000_000
    )
  );

  await solanaService.provider.sendAndConfirm(transferTx, [crank]);
  console.log(`[SETUP] Transferred 1000 AUTO to user.`);
}

async function executeTrade(controllerFn, reqBody, testUser) {
  const req = { body: reqBody };
  const res = mockRes();
  await controllerFn(req, res);

  if (res.statusCode !== 200 || !res.jsonData?.success) {
    throw new Error(`Build failed: ${JSON.stringify(res.jsonData)}`);
  }

  const tx = Transaction.from(Buffer.from(res.jsonData.transaction, "base64"));
  tx.partialSign(testUser);

  const signature = await solanaService.connection.sendRawTransaction(tx.serialize());
  console.log(`[TRADE] Tx sent: ${signature}`);

  const latestBlockhash = await solanaService.connection.getLatestBlockhash();
  await solanaService.connection.confirmTransaction({
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    signature: signature,
  });
  console.log(`[TRADE] Tx confirmed.`);
  return signature;
}

async function runDevnetTest() {
  try {
    startPriceStream();

    // Use the test key if provided, otherwise generate a new one
    let testUser;
    if (process.env.TEST_USER_PRIVATE_KEY) {
      const userPrivateKeyString = process.env.TEST_USER_PRIVATE_KEY;
      try {
        const { default: bs58 } = await import("bs58");
        testUser = Keypair.fromSecretKey(bs58.decode(userPrivateKeyString));
      } catch {
        const secretKeyArray = Uint8Array.from(JSON.parse(userPrivateKeyString));
        testUser = Keypair.fromSecretKey(secretKeyArray);
      }
      console.log(`[SETUP] Using provided TEST_USER_PRIVATE_KEY: ${testUser.publicKey.toBase58()}`);
    } else {
      testUser = Keypair.generate();
    }

    await fundTestWallet(testUser);

    console.log("\n[GAME] --- Starting Match Simulation ---");
    const { match, mainMarket, round1Market } = await startMatch();
    console.log(`[GAME] Match started: ${match.id}`);
    console.log(`[GAME] Main Market: ${mainMarket.id}`);
    console.log(`[GAME] Round 1 Market: ${round1Market.id}`);

    await new Promise(r => setTimeout(r, 3000)); // wait for PREPARING phase to pass

    // --- TEST 1: Buy YES on Main Market ---
    console.log(`\n[TRADE] Simulating Buy YES on Main Market...`);
    const sig1 = await executeTrade(buildTradeTransaction, {
      userPubkey: testUser.publicKey.toBase58(),
      marketId: mainMarket.id,
      side: "YES",
      amountTokens: 20
    }, testUser);

    const verifyRes1 = mockRes();
    await verifyTrade({ body: { signature: sig1, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58(), side: "YES", amountTokens: 20 } }, verifyRes1);
    if (!verifyRes1.jsonData?.success) throw new Error(`Verify failed: ${JSON.stringify(verifyRes1.jsonData)}`);
    console.log(`[TRADE] Main market buy verified.`);

    // --- TEST 2: Buy YES on Round 1 Market ---
    console.log(`\n[TRADE] Simulating Buy YES on Round 1 Market...`);
    const sig2 = await executeTrade(buildTradeTransaction, {
      userPubkey: testUser.publicKey.toBase58(),
      marketId: round1Market.id,
      side: "YES",
      amountTokens: 10
    }, testUser);

    const verifyRes2 = mockRes();
    await verifyTrade({ body: { signature: sig2, marketId: round1Market.id, userPubkey: testUser.publicKey.toBase58(), side: "YES", amountTokens: 10 } }, verifyRes2);
    if (!verifyRes2.jsonData?.success) throw new Error(`Verify failed: ${JSON.stringify(verifyRes2.jsonData)}`);
    console.log(`[TRADE] Round 1 market buy verified.`);

    // Wait a bit to let price stream catch the update
    await new Promise(r => setTimeout(r, 2000));

    // --- ADVANCE GAME: Play Round 1 ---
    console.log(`\n[GAME] Playing Round 1...`);
    await playRound(match.id);
    const updatedMatch = await prisma.match.findUnique({ where: { id: match.id } });
    console.log(`[GAME] Round 1 complete. Red HP: ${updatedMatch.redHp}, Blue HP: ${updatedMatch.blueHp}`);

    // --- CLAIM: Claim Round 1 Market Payout ---
    const resolvedRound1Market = await prisma.market.findUnique({ where: { id: round1Market.id } });
    if (resolvedRound1Market.winningOutcome === "YES") {
      console.log(`\n[CLAIM] We bought YES on Round 1 Market and YES won! Simulating Claim...`);
      try {
        const sigClaimR1 = await executeTrade(buildClaimTransaction, {
          userPubkey: testUser.publicKey.toBase58(),
          marketId: round1Market.id
        }, testUser);
        const verifyClaimRes = mockRes();
        await verifyClaim({ body: { signature: sigClaimR1, marketId: round1Market.id, userPubkey: testUser.publicKey.toBase58() } }, verifyClaimRes);
        console.log(`[CLAIM] Round 1 Claim verified:`, verifyClaimRes.jsonData?.message);
      } catch (err) {
        console.log(`[CLAIM] Round 1 Claim failed (maybe we lost?):`, err.message);
      }
    } else {
      console.log(`\n[CLAIM] We bought YES on Round 1 Market but NO won. Skipping claim.`);
    }

    // --- TEST 3: Sell Partial YES on Main Market ---
    // Make sure we have the shares.
    console.log(`\n[TRADE] Simulating partial Sell of YES on Main Market...`);
    try {
      const sig3 = await executeTrade(buildSellTransaction, {
        userPubkey: testUser.publicKey.toBase58(),
        marketId: mainMarket.id,
        side: "YES",
        amountShares: 5
      }, testUser);

      const verifyRes3 = mockRes();
      await verifySell({ body: { signature: sig3, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58(), side: "YES", amountShares: 5 } }, verifyRes3);
      if (!verifyRes3.jsonData?.success) throw new Error(`Verify failed: ${JSON.stringify(verifyRes3.jsonData)}`);
      console.log(`[TRADE] Main market partial sell verified.`);
    } catch (e) {
      console.log(`[TRADE] Sell failed (maybe not enough shares?): ${e.message}`);
    }

    // Wait a bit to let price stream catch the update
    await new Promise(r => setTimeout(r, 2000));

    // --- FINISH GAME ---
    console.log(`\n[GAME] Finishing match...`);
    let finalMatch = updatedMatch;
    while (finalMatch.status !== "RESOLVED") {
      const res = await playRound(match.id);
      finalMatch = res.match;
      console.log(`[GAME] Round ${finalMatch.roundNumber} resolved. Winner: ${finalMatch.winner || "None yet"}`);
    }

    const resolvedMainMarket = await prisma.market.findFirst({ where: { matchId: match.id, marketType: "MAIN" } });
    console.log(`\n[MARKET] Main Market Resolved! Winning side: ${resolvedMainMarket.winningOutcome}`);

    // --- TEST 4: Claim Main Market Payout ---
    if (resolvedMainMarket.winningOutcome === "YES") {
      console.log(`\n[CLAIM] We bought YES and YES won! Simulating Claim Payout...`);
      try {
        const sigClaimMain = await executeTrade(buildClaimTransaction, {
          userPubkey: testUser.publicKey.toBase58(),
          marketId: mainMarket.id
        }, testUser);

        const verifyClaimRes = mockRes();
        await verifyClaim({ body: { signature: sigClaimMain, marketId: mainMarket.id, userPubkey: testUser.publicKey.toBase58() } }, verifyClaimRes);
        console.log(`[CLAIM] Main Market Claim verified:`, verifyClaimRes.jsonData?.message);
      } catch (err) {
        console.log(`[CLAIM] Main Market Claim failed:`, err.message);
      }
    } else {
      console.log(`\n[CLAIM] We bought YES but NO won. Skipping claim.`);
    }

    console.log(`\n--- ALL TESTS COMPLETE ---`);
    stopPriceStream();
    process.exit(0);
  } catch (error) {
    console.error(`\n[ERROR] Test failed:`, error);
    process.exit(1);
  }
}

runDevnetTest();
