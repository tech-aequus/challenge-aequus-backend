-- AlterTable
ALTER TABLE "_UserChats" ADD CONSTRAINT "_UserChats_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_UserChats_AB_unique";
