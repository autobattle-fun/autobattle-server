-- CreateTable
CREATE TABLE "MatchRound" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "redScoreInit" INTEGER NOT NULL,
    "blueScoreInit" INTEGER NOT NULL,
    "redScoreFinal" INTEGER NOT NULL,
    "blueScoreFinal" INTEGER NOT NULL,
    "redHpBefore" INTEGER NOT NULL,
    "blueHpBefore" INTEGER NOT NULL,
    "redHpAfter" INTEGER NOT NULL,
    "blueHpAfter" INTEGER NOT NULL,
    "damageDealt" INTEGER NOT NULL,
    "roundWinner" TEXT,
    "redCardsDealt" JSONB NOT NULL DEFAULT '[]',
    "blueCardsDealt" JSONB NOT NULL DEFAULT '[]',
    "riverRedCard" JSONB,
    "riverBlueCard" JSONB,
    "tiebreakerCards" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundMove" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "moveNumber" INTEGER NOT NULL,
    "player" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "model" TEXT NOT NULL,
    "scoreBefore" INTEGER NOT NULL,
    "scoreAfter" INTEGER NOT NULL,
    "cardDealt" JSONB,
    "txSignature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchRound_matchId_idx" ON "MatchRound"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchRound_matchId_roundNumber_key" ON "MatchRound"("matchId", "roundNumber");

-- CreateIndex
CREATE INDEX "RoundMove_roundId_idx" ON "RoundMove"("roundId");

-- AddForeignKey
ALTER TABLE "MatchRound" ADD CONSTRAINT "MatchRound_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundMove" ADD CONSTRAINT "RoundMove_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MatchRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
