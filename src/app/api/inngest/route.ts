import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  executeWorkflow,
  handleGmailPoll,
  handleGoogleSheetsPoll,
  handleSchedulePoll,
  handleYoutubePoll,
  pollGmail,
  pollGoogleSheets,
  pollSchedules,
  pollYoutubeComments,
  pruneOldExecutions,
} from "@/inngest/functions";

// Inngest invokes this route once per durable step, so the ceiling that matters
// is the slowest SINGLE step (a large Sheets read), not a whole workflow run.
// 300s is the platform default on Vercel; stating it here keeps the limit with
// the code rather than in dashboard config.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    executeWorkflow,
    pollGmail,
    pollGoogleSheets,
    pollYoutubeComments,
    pollSchedules,
    handleGmailPoll,
    handleGoogleSheetsPoll,
    handleYoutubePoll,
    handleSchedulePoll,
    pruneOldExecutions,
  ],
});
