import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
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
  const { marketId, side, amountTokens } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(400)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  if (amountTokens < 0.0001) {
    return res.status(400).json({
      success: false,
      error: "Trade amount too small. Minimum is 0.0001 $AUTO.",
    });
  }

  try {
    const user = new PublicKey(userRecord.walletAddress);
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    const marketPda = new PublicKey(market.marketPda);
    const vaultPda = new PublicKey(market.vaultPda);
    const userTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    const buyIx = await solanaService.predMarket.methods
      .buyShares(
        side.toUpperCase() === "YES" ? { yes: {} } : { no: {} },
        new BN(amountTokens * 1_000_000),
        new BN(1),
      )
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount,
        mint: AUTO_MINT_ADDRESS,
        user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(buyIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    tx.recentBlockhash = blockhash;
    tx.feePayer = user; // ⛽️ USER PAYS GAS AND RENT

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
      // feePayer is now the user
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTradeController(req, res) {
  const { signature, marketId, side, amountTokens } = req.body;
  const userRecord = req.auth?.user;

  try {
    // 1. Confirm the transaction the user already sent
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // 2. Fetch Blockchain Truth
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    const userPk = new PublicKey(userRecord.walletAddress);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        new PublicKey(market.marketPda).toBuffer(),
        userPk.toBuffer(),
      ],
      PRED_MARKET_PROGRAM_ID,
    );

    const onChainPosition = await solanaService.fetchUserPosition(
      positionPda.toBase58(),
    );
    const exactShares =
      side.toUpperCase() === "YES"
        ? onChainPosition.yesShares.toNumber() / 1_000_000
        : onChainPosition.noShares.toNumber() / 1_000_000;

    // 3. Sync Database & Update User Stats
    const [syncedPrediction] = await prisma.$transaction([
      prisma.prediction.upsert({
        where: {
          userMarketSide: {
            userId: userRecord.id,
            marketId: market.id,
            side: side.toUpperCase(),
          },
        },
        update: {
          shareAmount: exactShares,
          amount: { increment: amountTokens },
        },
        create: {
          userId: userRecord.id,
          marketId: market.id,
          side: side.toUpperCase(),
          amount: amountTokens,
          shareAmount: exactShares,
          positionPda: positionPda.toBase58(),
          hasClaimed: false,
        },
      }),
      prisma.user.update({
        where: { id: userRecord.id },
        data: { totalPredictions: { increment: 1 } },
      }),
    ]);

    return res.status(200).json({ success: true, data: syncedPrediction });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildSellController(req, res) {
  const { marketId, side, amountShares } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  if (amountShares < 0.0001) {
    return res.status(400).json({
      success: false,
      error: "Share amount too small. Minimum is 0.0001 shares.",
    });
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
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), user.toBuffer()],
      PRED_MARKET_PROGRAM_ID,
    );

    const sideArg = side.toUpperCase() === "YES" ? { yes: {} } : { no: {} };
    const rawAmount = new BN(Math.floor(amountShares * 1_000_000));

    const sellIx = await solanaService.predMarket.methods
      .sellShares(sideArg, rawAmount, new BN(1))
      .accounts({
        market: marketPda,
        userPosition: positionPda,
        vault: vaultPda,
        userTokenAccount,
        mint: AUTO_MINT_ADDRESS,
        user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(sellIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    tx.recentBlockhash = blockhash;
    tx.feePayer = user; // ⛽️ USER PAYS GAS (No Openfort here)

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifySellController(req, res) {
  const { signature, marketId, side } = req.body;
  const userRecord = req.auth?.user;

  try {
    // 1. Confirm the transaction the user broadcasted from the frontend
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // 2. Fetch the absolute Source of Truth from the Blockchain
    const market = await prisma.market.findUnique({ where: { id: marketId } });
    const userPk = new PublicKey(userRecord.walletAddress);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        new PublicKey(market.marketPda).toBuffer(),
        userPk.toBuffer(),
      ],
      PRED_MARKET_PROGRAM_ID,
    );

    const onChainPosition = await solanaService.fetchUserPosition(
      positionPda.toBase58(),
    );
    const exactYesShares = onChainPosition.yesShares.toNumber() / 1_000_000;
    const exactNoShares = onChainPosition.noShares.toNumber() / 1_000_000;

    const dbSide = side.toUpperCase();
    const exactSharesLeftToSave =
      dbSide === "YES" ? exactYesShares : exactNoShares;

    // 3. Sync the DB
    await prisma.prediction.update({
      where: {
        userMarketSide: {
          userId: userRecord.id,
          marketId: market.id,
          side: dbSide,
        },
      },
      data: { shareAmount: exactSharesLeftToSave },
    });

    return res
      .status(200)
      .json({ success: true, message: "Sell synced successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildTransferController(req, res) {
  const { recipientAddress, amountTokens } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  try {
    const sender = new PublicKey(userRecord.walletAddress);
    const recipient = new PublicKey(recipientAddress);
    const senderAta = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      sender,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const recipientAta = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      recipient,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const tx = new Transaction();

    // 1. Check if recipient needs an ATA
    const recipientAtaInfo =
      await solanaService.connection.getAccountInfo(recipientAta);
    if (!recipientAtaInfo) {
      // User (sender) pays the rent for the recipient's new account
      tx.add(
        createAssociatedTokenAccountInstruction(
          sender,
          recipientAta,
          recipient,
          AUTO_MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
    }

    // 2. Add Transfer instruction
    tx.add(
      createTransferInstruction(
        senderAta,
        recipientAta,
        sender,
        Math.floor(amountTokens * 1_000_000),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender; // ⛽️ USER PAYS GAS AND RENT

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifyTransferController(req, res) {
  const { signature } = req.body;

  try {
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // Confirm the user's broadcasted signature
    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return res.status(200).json({
      success: true,
      message: "Transfer verified successfully.",
      signature: signature,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function buildClaimController(req, res) {
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

    const onChainState = await solanaService.fetchMarketState(
      marketPda.toBase58(),
    );
    if (!onChainState.lpWithdrawn) {
      return res.status(400).json({
        success: false,
        error: "Please wait a moment. The market is finalizing payouts.",
      });
    }

    const userTokenAccount = getAssociatedTokenAddressSync(
      AUTO_MINT_ADDRESS,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
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
        mint: AUTO_MINT_ADDRESS,
        user: user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(claimIx);
    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    // ⛽️ STANDARD PATTERN: User pays their own gas
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
  const { signature, marketId } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.id) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  if (!signature || !marketId) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields (signature, marketId).",
    });
  }

  try {
    // 1. Confirm the transaction the user broadcasted
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // 2. Security verification
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

    const market = await prisma.market.findUnique({
      where: { id: marketId },
    });

    if (!market || market.status !== "RESOLVED" || !market.winningOutcome) {
      return res.status(400).json({
        success: false,
        error: "Market is not resolved or lacks a winning outcome.",
      });
    }

    const onChainMarket = await solanaService.fetchMarketState(
      market.marketPda,
    );
    const payoutRatio = onChainMarket.winnerPayoutRatio.toNumber();

    // 3. Fetch the pending predictions to calculate earnings
    const pendingPredictions = await prisma.prediction.findMany({
      where: {
        marketId: marketId,
        userId: userRecord.id,
        hasClaimed: false,
      },
    });

    if (pendingPredictions.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "No pending prediction found to update. It might already be marked as claimed.",
      });
    }

    // Calculate total earned: 1 winning share = 1 payout token
    const tokensEarned = pendingPredictions.reduce((sum, p) => {
      if (p.side === market.winningOutcome) {
        const actualPayout =
          (Number(p.shareAmount) * payoutRatio) / 1_000_000_000;
        return sum + actualPayout;
      }
      return sum;
    }, 0);

    // 4. Update the database securely using a Transaction
    const dbOperations = [
      // Mark all pending predictions for this market as claimed
      prisma.prediction.updateMany({
        where: {
          marketId: marketId,
          userId: userRecord.id,
          hasClaimed: false,
        },
        data: { hasClaimed: true },
      }),
    ];

    // Only update the user's win stats if they actually had winning shares
    if (tokensEarned > 0) {
      dbOperations.push(
        prisma.user.update({
          where: { id: userRecord.id },
          data: {
            totalWins: { increment: 1 },
            totalEarnings: { increment: tokensEarned },
          },
        }),
      );
    }

    await prisma.$transaction(dbOperations);

    return res.status(200).json({
      success: true,
      message: `Claim successfully verified! Won ${tokensEarned} tokens.`,
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
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const txSig = await solanaService.predMarket.methods
      .withdrawLp()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        adminTokenAccount: creatorTokenAccount,
        mint: AUTO_MINT_ADDRESS,
        authority: crank.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
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

export async function buildSolTransferController(req, res) {
  // 🔐 Security: Sender is strictly pulled from the auth token
  const { recipientAddress, amountSol } = req.body;
  const userRecord = req.auth?.user;

  if (!userRecord || !userRecord.walletAddress) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized or missing wallet." });
  }

  if (!recipientAddress || !amountSol) {
    return res
      .status(400)
      .json({ success: false, error: "Missing recipient or amount." });
  }

  try {
    const sender = new PublicKey(userRecord.walletAddress);
    const recipient = new PublicKey(recipientAddress);

    const tx = new Transaction();

    // Add Native SOL Transfer instruction (1 SOL = 1,000,000,000 Lamports)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: recipient,
        lamports: Math.floor(amountSol * 1_000_000_000),
      }),
    );

    const { blockhash } =
      await solanaService.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender; // ⛽️ USER PAYS GAS

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString("base64"),
    });
  } catch (error) {
    console.error("Build SOL transfer error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function verifySolTransferController(req, res) {
  const { signature } = req.body;

  if (!signature) {
    return res
      .status(400)
      .json({ success: false, error: "Missing signature." });
  }

  try {
    const { blockhash, lastValidBlockHeight } =
      await solanaService.connection.getLatestBlockhash("confirmed");

    // Confirm the user's broadcasted signature
    await solanaService.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // Note: No DB updates needed for pure SOL transfers unless you are explicitly tracking SOL balances in Prisma.

    return res.status(200).json({
      success: true,
      message: "SOL Transfer verified successfully.",
      signature: signature,
    });
  } catch (error) {
    console.error("Verify SOL transfer error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
