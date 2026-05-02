/*
  Warnings:

  - You are about to drop the column `authProvider` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `privyUserId` on the `User` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "User_privyUserId_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "authProvider",
DROP COLUMN "privyUserId";

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");
