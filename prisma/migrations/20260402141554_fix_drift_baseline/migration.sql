-- DropForeignKey
ALTER TABLE "InstagramSettings" DROP CONSTRAINT "InstagramSettings_userId_fkey";

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "idempotencyKey" TEXT;

-- DropTable
DROP TABLE "InstagramSettings";
-- CreateTable
CREATE TABLE "AiReplySettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountDescription" TEXT,
    "replyTone" TEXT,
    "replyGoal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReplySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiReplySettings_userId_key" ON "AiReplySettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_idempotencyKey_key" ON "Execution"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "AiReplySettings" ADD CONSTRAINT "AiReplySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


