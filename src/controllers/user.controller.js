import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getUserHistory,
  getPredictionDetail,
} from "../services/user.service.js";
import { validate, listPredictionsSchema } from "../utils/validators.js";
import { prisma } from "../db/prisma.js";

const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");

export async function meController(request, response) {
  if (!request.auth?.user) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const walletAddress = request.auth.user?.walletAddress;
  const tokenMintAddress = process.env.AUTO_TOKEN_ADDRESS;

  const walletPublicKey = new PublicKey(walletAddress);
  const mintPublicKey = new PublicKey(tokenMintAddress);

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    walletPublicKey,
    {
      mint: mintPublicKey,
    },
  );

  const lamports = await connection.getBalance(walletPublicKey);
  const solBalance = lamports / LAMPORTS_PER_SOL;

  let splTokenBalance = 0;

  if (tokenAccounts.value.length > 0) {
    splTokenBalance =
      tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  }

  return response.json({
    user: request.auth.user,
    metadata: {
      splTokenBalance,
      solBalance,
    },
  });
}

export async function historyController(request, response) {
  const { username } = request.params;
  const user = await prisma.user.findUnique({
    where: {
      username: username,
    },
  });

  if (!user) {
    return response.status(404).json({ error: "User not found" });
  }

  const { page, limit } = validate(listPredictionsSchema, request.query || {});

  const result = await getUserHistory(user.id, page, limit);
  return response.json({
    success: true,
    user: user,
    ...result,
  });
}

export async function predictionDetailController(request, response) {
  const { id } = request.params;
  const prediction = await getPredictionDetail(id);

  if (!prediction) {
    return response.status(404).json({ error: "Prediction not found" });
  }

  return response.json({
    success: true,
    data: prediction,
  });
}

export async function getUserById(request, response) {
  const { userId } = request.params;
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!user) {
    return response.json({
      success: true,
      user: null,
    });
  }

  return response.json({
    success: true,
    data: user,
  });
}

export async function createUser(request, response) {
  const user = request.auth.user;
  const session = request.auth.session;

  if (user) {
    return response.status(400).json({ error: "User already exists" });
  }

  const { username, walletAddress } = request.body;

  const newUser = await prisma.user.create({
    data: {
      id: session?.user?.id,
      username,
      walletAddress,
      email: session?.user?.email,
    },
  });

  return response.json({
    success: true,
    data: newUser,
  });
}
