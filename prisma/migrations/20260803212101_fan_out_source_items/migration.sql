-- CreateTable
CREATE TABLE "FanOutSource" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FanOutSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FanOutItem" (
    "sourceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "item" JSONB NOT NULL,

    CONSTRAINT "FanOutItem_pkey" PRIMARY KEY ("sourceId","index")
);

-- CreateIndex
CREATE UNIQUE INDEX "FanOutSource_executionId_nodeId_key" ON "FanOutSource"("executionId", "nodeId");

-- AddForeignKey
ALTER TABLE "FanOutSource" ADD CONSTRAINT "FanOutSource_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FanOutItem" ADD CONSTRAINT "FanOutItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FanOutSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
