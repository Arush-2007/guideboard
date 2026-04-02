-- CreateIndex
CREATE INDEX "Execution_workflowId_startedAt_idx" ON "Execution"("workflowId", "startedAt");

-- CreateIndex
CREATE INDEX "Execution_workflowId_status_startedAt_idx" ON "Execution"("workflowId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "Workflow_userId_updatedAt_idx" ON "Workflow"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Workflow_userId_name_idx" ON "Workflow"("userId", "name");

-- CreateIndex
CREATE INDEX "Node_workflowId_idx" ON "Node"("workflowId");

-- CreateIndex
CREATE INDEX "Credential_userId_updatedAt_idx" ON "Credential"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Credential_userId_name_idx" ON "Credential"("userId", "name");

-- CreateIndex
CREATE INDEX "Credential_userId_type_updatedAt_idx" ON "Credential"("userId", "type", "updatedAt");

-- CreateIndex
CREATE INDEX "YoutubeCommentPoll_workflowId_idx" ON "YoutubeCommentPoll"("workflowId");

