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
