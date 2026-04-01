-- CreateTable
CREATE TABLE "YoutubeCommentPoll" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoutubeCommentPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeCommentPoll_workflowId_videoId_key" ON "YoutubeCommentPoll"("workflowId", "videoId");

-- AddForeignKey
ALTER TABLE "YoutubeCommentPoll" ADD CONSTRAINT "YoutubeCommentPoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoutubeCommentPoll" ADD CONSTRAINT "YoutubeCommentPoll_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
