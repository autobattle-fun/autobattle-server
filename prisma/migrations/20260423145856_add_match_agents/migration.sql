/*
  Warnings:

  - A unique constraint covering the columns `[matchUuid]` on the table `Match` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `llmBlue` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `llmRed` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `matchUuid` to the `Match` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "llmBlue" TEXT NOT NULL,
ADD COLUMN     "llmRed" TEXT NOT NULL,
ADD COLUMN     "matchUuid" TEXT NOT NULL,
ADD COLUMN     "winner" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Match_matchUuid_key" ON "Match"("matchUuid");
