-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CredentialType" ADD VALUE 'AFFINDA';
ALTER TYPE "CredentialType" ADD VALUE 'LEVER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeType" ADD VALUE 'RESUME_PARSER';
ALTER TYPE "NodeType" ADD VALUE 'CANDIDATE_SCORING';
ALTER TYPE "NodeType" ADD VALUE 'ATS_ACTION';
