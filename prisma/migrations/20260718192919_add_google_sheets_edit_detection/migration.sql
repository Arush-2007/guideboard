-- AlterTable
ALTER TABLE "GoogleSheetsPoll" ADD COLUMN     "rowHashes" JSONB,
ADD COLUMN     "triggerOn" TEXT NOT NULL DEFAULT 'added';
