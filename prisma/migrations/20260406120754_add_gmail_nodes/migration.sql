-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeType" ADD VALUE 'GMAIL_TRIGGER';
ALTER TYPE "NodeType" ADD VALUE 'GMAIL_ACTION';

-- CreateTable
CREATE TABLE "GmailPoll" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailPoll_workflowId_key" ON "GmailPoll"("workflowId");

-- CreateIndex
CREATE INDEX "GmailPoll_userId_idx" ON "GmailPoll"("userId");

-- AddForeignKey
ALTER TABLE "GmailPoll" ADD CONSTRAINT "GmailPoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailPoll" ADD CONSTRAINT "GmailPoll_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
