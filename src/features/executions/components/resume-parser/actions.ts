"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { resumeParserChannel } from "@/inngest/channels/resume-parser";

export async function fetchResumeParserRealtimeToken() {
  return mintUserStatusToken(resumeParserChannel);
}
