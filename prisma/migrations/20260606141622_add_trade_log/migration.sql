-- CreateTable
CREATE TABLE "TradeLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeLog_userId_idx" ON "TradeLog"("userId");

-- CreateIndex
CREATE INDEX "TradeLog_createdAt_idx" ON "TradeLog"("createdAt");
