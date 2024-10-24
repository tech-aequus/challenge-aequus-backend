/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Claim` table. All the data in the column will be lost.
  - You are about to drop the column `evidence` on the `Claim` table. All the data in the column will be lost.
  - You are about to drop the column `result` on the `Claim` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `Claim` table. All the data in the column will be lost.
  - Added the required column `claimantId` to the `Claim` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Claim" DROP CONSTRAINT "Claim_userId_fkey";

-- AlterTable
ALTER TABLE "Challenge" ADD COLUMN     "claimTime" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "winnerId" TEXT;

-- AlterTable
ALTER TABLE "Claim" DROP COLUMN "createdAt",
DROP COLUMN "evidence",
DROP COLUMN "result",
DROP COLUMN "userId",
ADD COLUMN     "claimantId" TEXT NOT NULL,
ADD COLUMN     "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;
