/*
  Warnings:

  - The values [INSTAGRAM_AI_REPLY] on the enum `NodeType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "NodeType_new" AS ENUM ('INITIAL', 'MANUAL_TRIGGER', 'HTTP_REQUEST', 'GOOGLE_FORM_TRIGGER', 'STRIPE_TRIGGER', 'INSTAGRAM_COMMENT_TRIGGER', 'INSTAGRAM_REPLY_COMMENT', 'AI_REPLY_GENERATOR', 'ANTHROPIC', 'GEMINI', 'OPENAI', 'DISCORD', 'SLACK');
ALTER TABLE "Node" ALTER COLUMN "type" TYPE "NodeType_new" USING ("type"::text::"NodeType_new");
ALTER TYPE "NodeType" RENAME TO "NodeType_old";
ALTER TYPE "NodeType_new" RENAME TO "NodeType";
DROP TYPE "public"."NodeType_old";
COMMIT;
