-- CreateTable
CREATE TABLE "NodeInputSnapshot" (
    "executionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeInputSnapshot_pkey" PRIMARY KEY ("executionId","nodeId")
);

-- AddForeignKey
ALTER TABLE "NodeInputSnapshot" ADD CONSTRAINT "NodeInputSnapshot_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
