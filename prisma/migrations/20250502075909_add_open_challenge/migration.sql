/*
  Warnings:

  - You are about to drop the column `challengeId` on the `OpenChallenge` table. All the data in the column will be lost.
  - You are about to drop the column `postId` on the `OpenChallenge` table. All the data in the column will be lost.
  - Added the required column `coins` to the `OpenChallenge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `creatorId` to the `OpenChallenge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `game` to the `OpenChallenge` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "OpenChallenge" DROP CONSTRAINT "OpenChallenge_challengeId_fkey";

-- DropForeignKey
ALTER TABLE "OpenChallenge" DROP CONSTRAINT "OpenChallenge_postId_fkey";

-- DropIndex
DROP INDEX "OpenChallenge_challengeId_key";

-- DropIndex
DROP INDEX "OpenChallenge_postId_key";

-- AlterTable
ALTER TABLE "OpenChallenge" DROP COLUMN "challengeId",
DROP COLUMN "postId",
ADD COLUMN     "about" TEXT,
ADD COLUMN     "coins" INTEGER NOT NULL,
ADD COLUMN     "creatorId" TEXT NOT NULL,
ADD COLUMN     "game" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN';

-- AddForeignKey
ALTER TABLE "OpenChallenge" ADD CONSTRAINT "OpenChallenge_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
