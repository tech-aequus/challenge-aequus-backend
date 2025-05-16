/*
  Warnings:

  - The primary key for the `_UserChats` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[chatId]` on the table `Faction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[A,B]` on the table `_UserChats` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Faction" ADD COLUMN     "chatId" TEXT;

-- AlterTable
ALTER TABLE "_UserChats" DROP CONSTRAINT "_UserChats_AB_pkey";

-- CreateIndex
CREATE UNIQUE INDEX "Faction_chatId_key" ON "Faction"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "_UserChats_AB_unique" ON "_UserChats"("A", "B");

-- AddForeignKey
ALTER TABLE "Faction" ADD CONSTRAINT "Faction_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
