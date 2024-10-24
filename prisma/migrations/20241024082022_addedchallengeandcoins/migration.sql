/*
  Warnings:

  - Added the required column `coins` to the `Challenge` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Challenge" DROP CONSTRAINT "Challenge_creatorId_fkey";

-- DropForeignKey
ALTER TABLE "Challenge" DROP CONSTRAINT "Challenge_inviteeId_fkey";

-- AlterTable
ALTER TABLE "Challenge" ADD COLUMN     "coins" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;
