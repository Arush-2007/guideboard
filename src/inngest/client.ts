import { realtimeMiddleware } from "@inngest/realtime/middleware";
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: process.env.INNGEST_APP_ID || "workflow-automation-app",
  middleware: [realtimeMiddleware()],
});
