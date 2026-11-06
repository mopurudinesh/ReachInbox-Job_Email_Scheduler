ALTER TABLE "email_attachments"
  ADD COLUMN "inline" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contentId" TEXT;
