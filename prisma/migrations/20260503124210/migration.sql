/*
  Warnings:

  - A unique constraint covering the columns `[userId,marketId,side]` on the table `Prediction` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Prediction_positionPda_key";

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_userId_marketId_side_key" ON "Prediction"("userId", "marketId", "side");
