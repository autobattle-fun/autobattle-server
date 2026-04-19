import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const connection = new Connection(process.env.RPC_URL, "confirmed");

export async function meController(request, response) {
  if (!request.auth?.user) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const walletAddress = request.auth.user?.walletAddress;
  const tokenMintAddress = process.env.AUTO_TOKEN_ADDRESS;

  const walletPublicKey = new PublicKey(walletAddress);
  const mintPublicKey = new PublicKey(tokenMintAddress);

  const lamports = await connection.getBalance(walletPublicKey);
  const solBalance = lamports / LAMPORTS_PER_SOL;

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    walletPublicKey,
    {
      mint: mintPublicKey,
    },
  );

  let splTokenBalance = 0;

  if (tokenAccounts.value.length > 0) {
    splTokenBalance =
      tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  }

  return response.json({
    user: request.auth.user,
    metadata: {
      solBalance,
      splTokenBalance,
    },
  });
}
