-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'RESOLVED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PredictionSide" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('MAIN', 'MID_GAME');

-- CreateEnum
CREATE TYPE "ResolutionMethod" AS ENUM ('ON_CHAIN', 'AI_AGENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "authProvider" TEXT NOT NULL DEFAULT 'privy',
    "walletAddress" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "gameId" INTEGER NOT NULL,
    "gamePda" TEXT NOT NULL,
    "agentRed" TEXT NOT NULL,
    "agentBlue" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "roundNumber" INTEGER NOT NULL DEFAULT 1,
    "redHp" INTEGER NOT NULL DEFAULT 10,
    "blueHp" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "matchId" TEXT NOT NULL,
    "marketPda" TEXT NOT NULL,
    "vaultPda" TEXT NOT NULL,
    "marketIndex" INTEGER NOT NULL DEFAULT 0,
    "marketType" "MarketType" NOT NULL DEFAULT 'MAIN',
    "resolutionMethod" "ResolutionMethod" NOT NULL DEFAULT 'ON_CHAIN',
    "targetRound" INTEGER,
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "closesAt" TIMESTAMP(3) NOT NULL,
    "resolvesAt" TIMESTAMP(3),
    "winningOutcome" "PredictionSide",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" "PredictionSide" NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "positionPda" TEXT NOT NULL,
    "hasClaimed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_privyUserId_key" ON "User"("privyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Match_gameId_key" ON "Match"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_gamePda_key" ON "Match"("gamePda");

-- CreateIndex
CREATE UNIQUE INDEX "Market_slug_key" ON "Market"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Market_marketPda_key" ON "Market"("marketPda");

-- CreateIndex
CREATE UNIQUE INDEX "Market_vaultPda_key" ON "Market"("vaultPda");

-- CreateIndex
CREATE INDEX "Market_matchId_idx" ON "Market"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_positionPda_key" ON "Prediction"("positionPda");

-- CreateIndex
CREATE INDEX "Prediction_marketId_idx" ON "Prediction"("marketId");

-- CreateIndex
CREATE INDEX "Prediction_userId_idx" ON "Prediction"("userId");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
