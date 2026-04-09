import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  executeWorkflow,
  pollGmail,
  pollGoogleSheets,
  pollYoutubeComments,
  pruneOldExecutions,
} from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    executeWorkflow,
    pollGmail,
    pollGoogleSheets,
    pollYoutubeComments,
    pruneOldExecutions,
  ],
});
