/*
  Warnings:

  - You are about to drop the column `accessToken` on the `slack_integrations` table. All the data in the column will be lost.
  - You are about to drop the column `incomingWebhookUrl` on the `slack_integrations` table. All the data in the column will be lost.
  - Added the required column `accessTokenEncrypted` to the `slack_integrations` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "rate_limit_logs" ADD COLUMN     "slackNotificationClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "slack_integrations" DROP COLUMN "accessToken",
DROP COLUMN "incomingWebhookUrl",
ADD COLUMN     "accessTokenEncrypted" TEXT NOT NULL,
ADD COLUMN     "incomingWebhookEncrypted" TEXT;
