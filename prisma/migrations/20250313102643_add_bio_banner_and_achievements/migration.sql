-- AlterTable
ALTER TABLE "User" ADD COLUMN     "achievements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "banner" TEXT NOT NULL DEFAULT 'https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png',
ADD COLUMN     "bio" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "achievementName" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "bannerImage" TEXT NOT NULL DEFAULT 'https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Achievement_achievementName_key" ON "Achievement"("achievementName");
