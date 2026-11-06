CREATE TABLE "campaign_idempotency" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "recipientCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_idempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_idempotency_userId_key_key"
  ON "campaign_idempotency"("userId", "key");
CREATE INDEX "campaign_idempotency_campaignId_idx"
  ON "campaign_idempotency"("campaignId");

ALTER TABLE "campaign_idempotency"
  ADD CONSTRAINT "campaign_idempotency_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
