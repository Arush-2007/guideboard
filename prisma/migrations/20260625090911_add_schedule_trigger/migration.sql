-- AlterEnum
ALTER TYPE "NodeType" ADD VALUE 'SCHEDULE_TRIGGER';

-- CreateTable
CREATE TABLE "SchedulePoll" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulePoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchedulePoll_workflowId_key" ON "SchedulePoll"("workflowId");

-- CreateIndex
CREATE INDEX "SchedulePoll_nextRunAt_idx" ON "SchedulePoll"("nextRunAt");

-- AddForeignKey
ALTER TABLE "SchedulePoll" ADD CONSTRAINT "SchedulePoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePoll" ADD CONSTRAINT "SchedulePoll_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
