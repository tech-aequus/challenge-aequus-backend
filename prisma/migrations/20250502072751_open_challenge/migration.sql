-- CreateTable
CREATE TABLE "OpenChallenge" (
    "id" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "challengeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpenChallenge_postId_key" ON "OpenChallenge"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "OpenChallenge_challengeId_key" ON "OpenChallenge"("challengeId");

-- AddForeignKey
ALTER TABLE "OpenChallenge" ADD CONSTRAINT "OpenChallenge_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenChallenge" ADD CONSTRAINT "OpenChallenge_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
