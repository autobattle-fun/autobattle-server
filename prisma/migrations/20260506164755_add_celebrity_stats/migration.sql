-- AlterTable
ALTER TABLE "Celebrity" ADD COLUMN     "matchesPlayed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "wins" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "blueCelebId" TEXT,
ADD COLUMN     "redCelebId" TEXT;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_redCelebId_fkey" FOREIGN KEY ("redCelebId") REFERENCES "Celebrity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_blueCelebId_fkey" FOREIGN KEY ("blueCelebId") REFERENCES "Celebrity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
