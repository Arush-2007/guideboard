-- CreateTable
CREATE TABLE "InstagramSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountDescription" TEXT,
    "replyTone" TEXT,
    "replyGoal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstagramSettings_userId_key" ON "InstagramSettings"("userId");

-- AddForeignKey
ALTER TABLE "InstagramSettings" ADD CONSTRAINT "InstagramSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
