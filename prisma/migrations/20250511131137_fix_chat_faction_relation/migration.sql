/*
  Warnings:

  - A unique constraint covering the columns `[factionId]` on the table `Chat` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "Faction" DROP CONSTRAINT "Faction_chatId_fkey";

-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "factionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Chat_factionId_key" ON "Chat"("factionId");

-- AddForeignKey
ALTER TABLE "Faction" ADD CONSTRAINT "Faction_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
