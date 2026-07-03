import { channel, topic } from "@inngest/realtime";

export const RESUME_PARSER_CHANNEL_NAME = "resume-parser-execution";

export const resumeParserChannel = channel(
  (userId: string) => `${RESUME_PARSER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
