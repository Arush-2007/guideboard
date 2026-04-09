-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeType" ADD VALUE 'GOOGLE_SHEETS_TRIGGER';
ALTER TYPE "NodeType" ADD VALUE 'GOOGLE_SHEETS_ACTION';

-- CreateTable
CREATE TABLE "GoogleSheetsPoll" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL,
    "lastRowCount" INTEGER NOT NULL DEFAULT 0,
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleSheetsPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleSheetsPoll_workflowId_key" ON "GoogleSheetsPoll"("workflowId");

-- CreateIndex
CREATE INDEX "GoogleSheetsPoll_userId_idx" ON "GoogleSheetsPoll"("userId");

-- CreateIndex
CREATE INDEX "GoogleSheetsPoll_workflowId_spreadsheetId_idx" ON "GoogleSheetsPoll"("workflowId", "spreadsheetId");

-- AddForeignKey
ALTER TABLE "GoogleSheetsPoll" ADD CONSTRAINT "GoogleSheetsPoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetsPoll" ADD CONSTRAINT "GoogleSheetsPoll_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
