-- AlterTable
ALTER TABLE "Execution" ADD COLUMN "replayOfId" TEXT;

-- CreateIndex
CREATE INDEX "Execution_replayOfId_idx" ON "Execution"("replayOfId");

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_replayOfId_fkey" FOREIGN KEY ("replayOfId") REFERENCES "Execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
