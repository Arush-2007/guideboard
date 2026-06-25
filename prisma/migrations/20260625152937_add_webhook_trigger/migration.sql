-- AlterEnum
ALTER TYPE "NodeType" ADD VALUE 'WEBHOOK_TRIGGER';

-- CreateTable
CREATE TABLE "WebhookTrigger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookTrigger_workflowId_key" ON "WebhookTrigger"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookTrigger_token_key" ON "WebhookTrigger"("token");

-- AddForeignKey
ALTER TABLE "WebhookTrigger" ADD CONSTRAINT "WebhookTrigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTrigger" ADD CONSTRAINT "WebhookTrigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
