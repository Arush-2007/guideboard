-- CreateTable
CREATE TABLE "InstagramCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "instagramUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramCredential_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "InstagramCredential" ADD CONSTRAINT "InstagramCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
