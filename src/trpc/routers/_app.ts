import { conversationsRouter } from "@/features/conversations/server/router";
import { credentialsRouter } from "@/features/credentials/server/routers";
import { executionsRouter } from "@/features/executions/server/routers";
import { aiReplySettingsRouter } from "@/features/instagram-settings/server/routers";
import { scheduleRouter } from "@/features/triggers/server/schedule-router";
import { webhookRouter } from "@/features/triggers/server/webhook-router";
import { workflowsRouter } from "@/features/workflows/server/routers";
import { createTRPCRouter } from "../init";

export const appRouter = createTRPCRouter({
  workflows: workflowsRouter,
  credentials: credentialsRouter,
  executions: executionsRouter,
  aiReplySettings: aiReplySettingsRouter,
  conversations: conversationsRouter,
  schedule: scheduleRouter,
  webhook: webhookRouter,
});
// export type definition of API
export type AppRouter = typeof appRouter;
