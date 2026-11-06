-- CreateTable
CREATE TABLE "email_attempts" (
    "id" TEXT NOT NULL,
    "emailJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "smtpMessageId" TEXT,
    "previewUrl" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "email_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_attempts_emailJobId_startedAt_idx" ON "email_attempts"("emailJobId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_attempts_emailJobId_attemptNumber_key" ON "email_attempts"("emailJobId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "email_attempts" ADD CONSTRAINT "email_attempts_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "email_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
