import { decryptToken } from './token-crypto.js';
import { prisma } from './db.js';

const CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

export async function notifyHourlyLimit(senderId: string, windowStart: Date): Promise<void> {
  const rateLog = await prisma.rateLimitLog.upsert({
    where: { senderId_windowStart: { senderId, windowStart } },
    create: { senderId, windowStart },
    update: {},
  });
  if (rateLog.slackNotified) return;

  const sender = await prisma.senderAccount.findUnique({
    where: { id: senderId },
    include: { user: true },
  });
  if (!sender) return;

  const integration = await prisma.slackIntegration.findFirst({ where: { userId: sender.userId } });
  if (!integration) return;

  const now = new Date();
  const claim = await prisma.rateLimitLog.updateMany({
    where: {
      id: rateLog.id,
      slackNotified: false,
      OR: [
        { slackNotificationClaimedAt: null },
        { slackNotificationClaimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_AFTER_MS) } },
      ],
    },
    data: { slackNotificationClaimedAt: now },
  });
  if (claim.count === 0) return;

  const text = `Hourly email limit reached for ${sender.email}. Remaining scheduled emails are deferred until ${new Date(windowStart.getTime() + 3_600_000).toISOString()}.`;
  try {
    if (integration.incomingWebhookEncrypted) {
      const webhookUrl = decryptToken(integration.incomingWebhookEncrypted);
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}.`);
    } else if (integration.channelId) {
      const accessToken = decryptToken(integration.accessTokenEncrypted);
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          channel: integration.channelId,
          text,
          client_msg_id: `${senderId}-${windowStart.getTime()}`,
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(`Slack message was not accepted${result.error ? ` (${result.error})` : ''}.`);
    } else {
      await prisma.rateLimitLog.update({ where: { id: rateLog.id }, data: { slackNotificationClaimedAt: null } });
      return;
    }

    await prisma.rateLimitLog.update({ where: { id: rateLog.id }, data: { slackNotified: true } });
  } catch {
    await prisma.rateLimitLog.updateMany({
      where: { id: rateLog.id, slackNotified: false, slackNotificationClaimedAt: now },
      data: { slackNotificationClaimedAt: null },
    });
    console.error('[ReachInbox Worker] Slack rate-limit notification failed; email delivery will continue.');
  }
}
