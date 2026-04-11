import { createTRPCRouter } from '../init';
import { workflowsRouter } from '@/features/workflows/server/routers';
import { credentialsRouter } from '@/features/credentials/server/routers';
import { executionsRouter } from '@/features/executions/server/routers';
import { aiReplySettingsRouter } from '@/features/instagram-settings/server/routers';
import { conversationsRouter } from '@/features/conversations/server/router';

export const appRouter = createTRPCRouter({
  workflows: workflowsRouter,
  credentials: credentialsRouter,
  executions: executionsRouter,
  aiReplySettings: aiReplySettingsRouter,
  conversations: conversationsRouter,
});
// export type definition of API
export type AppRouter = typeof appRouter;
