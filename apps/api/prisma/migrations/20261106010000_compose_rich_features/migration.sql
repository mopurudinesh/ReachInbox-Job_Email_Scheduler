ALTER TABLE "email_campaigns"
  ADD COLUMN "ccRecipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bccRecipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "email_attachments" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_attachments_campaignId_idx" ON "email_attachments"("campaignId");

ALTER TABLE "email_attachments"
  ADD CONSTRAINT "email_attachments_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
