-- Drop any remaining FOR_EACH rows before the enum value is removed (the
-- standalone "Multiple?" node was replaced by the multi-match policy inside
-- list-producing nodes; see src/lib/multi-match.ts). Connections cascade off
-- Node; NodeExecution rows are denormalized run history.
DELETE FROM "Node" WHERE "type" = 'FOR_EACH';
DELETE FROM "NodeExecution" WHERE "nodeType" = 'FOR_EACH';

-- AlterEnum
BEGIN;
CREATE TYPE "NodeType_new" AS ENUM ('INITIAL', 'MANUAL_TRIGGER', 'HTTP_REQUEST', 'GOOGLE_FORM_TRIGGER', 'TYPEFORM_TRIGGER', 'GMAIL_TRIGGER', 'GOOGLE_SHEETS_TRIGGER', 'SCHEDULE_TRIGGER', 'WEBHOOK_TRIGGER', 'INSTAGRAM_COMMENT_TRIGGER', 'INSTAGRAM_REPLY_COMMENT', 'YOUTUBE_COMMENT_TRIGGER', 'YOUTUBE_REPLY_COMMENT', 'AI_REPLY_GENERATOR', 'AI_TEXT', 'ANTHROPIC', 'CONDITION', 'SWITCH', 'RECORD_LOOKUP', 'CONVERT', 'GEMINI', 'OPENAI', 'DISCORD', 'SLACK', 'NOTION_ACTION', 'TELEGRAM_ACTION', 'TELEGRAM_TRIGGER', 'WHATSAPP_ACTION', 'GMAIL_ACTION', 'GOOGLE_SHEETS_ACTION', 'EXCEL_ACTION', 'RESUME_PARSER', 'CANDIDATE_SCORING', 'ATS_ACTION');
ALTER TABLE "Node" ALTER COLUMN "type" TYPE "NodeType_new" USING ("type"::text::"NodeType_new");
ALTER TABLE "NodeExecution" ALTER COLUMN "nodeType" TYPE "NodeType_new" USING ("nodeType"::text::"NodeType_new");
ALTER TYPE "NodeType" RENAME TO "NodeType_old";
ALTER TYPE "NodeType_new" RENAME TO "NodeType";
DROP TYPE "NodeType_old";
COMMIT;
