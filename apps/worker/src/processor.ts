import { DelayedError, type Job } from 'bullmq';
import nodemailer, { type SentMessageInfo } from 'nodemailer';
import Redis from 'ioredis';
import { reserveSendSlot } from './rate-limit.js';
import { prisma } from './db.js';
import { notifyHourlyLimit } from './slack-notifications.js';
import { safelyIndexEmailJob } from './search-index.js';
import { messageHtmlToText } from '@reachinbox/shared';

const smtpConfigured = Boolean(
  process.env.ETHEREAL_SMTP_USER &&
  process.env.ETHEREAL_SMTP_PASSWORD &&
  !process.env.ETHEREAL_SMTP_USER.startsWith('your_') &&
  !process.env.ETHEREAL_SMTP_PASSWORD.startsWith('your_'),
);
const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.ETHEREAL_SMTP_HOST || 'smtp.ethereal.email',
      port: Number(process.env.ETHEREAL_SMTP_PORT || 587),
      secure: process.env.ETHEREAL_SMTP_SECURE === 'true',
      auth: {
        user: process.env.ETHEREAL_SMTP_USER,
        pass: process.env.ETHEREAL_SMTP_PASSWORD,
      },
    })
  : null;

interface DeliveryPayload {
  emailJobId: string;
}

const pendingStatuses = ['SCHEDULED', 'QUEUED', 'DEFERRED'];

async function deferJob(job: Job<DeliveryPayload>, token: string, requestedTime: Date, reason: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await prisma.emailJob.findUnique({
      where: { id: job.data.emailJobId },
      select: { status: true, scheduledFor: true },
    });
    if (!latest || !pendingStatuses.includes(latest.status)) return;

    const targetTime = reason === 'SCHEDULED_START'
      ? latest.scheduledFor
      : new Date(Math.max(requestedTime.getTime(), latest.scheduledFor.getTime()));
    const scheduledFor = targetTime.getTime() <= Date.now() ? new Date(Date.now() + 1000) : targetTime;
    const updated = await prisma.emailJob.updateMany({
      where: { id: job.data.emailJobId, status: { in: pendingStatuses }, scheduledFor: latest.scheduledFor },
      data: { status: 'DEFERRED', scheduledFor, deferredReason: reason },
    });
    if (updated.count === 0) continue;

    await safelyIndexEmailJob(job.data.emailJobId);
    await job.moveToDelayed(scheduledFor.getTime(), token);
    throw new DelayedError();
  }
  throw new Error('The scheduled time changed repeatedly while the worker was deferring this email. BullMQ will retry it.');
}

export async function processEmail(job: Job<DeliveryPayload>, token?: string): Promise<void> {
  if (!token) throw new Error('BullMQ did not provide a lock token for the email job.');

  const emailJob = await prisma.emailJob.findUnique({
    where: { id: job.data.emailJobId },
    include: { campaign: { include: { sender: true, attachments: true } }, attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
  });
  if (!emailJob || ['SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(emailJob.status)) return;

  const lastAttempt = emailJob.attempts[0];
  if (emailJob.status === 'PROCESSING' && lastAttempt && !lastAttempt.completedAt) {
    await markUnknownOutcome(emailJob.id, 'Worker stopped during SMTP delivery; check the Ethereal mailbox before retrying.');
    return;
  }

  if (emailJob.scheduledFor.getTime() > Date.now()) {
    await deferJob(job, token, emailJob.scheduledFor, 'SCHEDULED_START');
    return;
  }

  const { campaign, recipientEmail } = emailJob;
  if (!transporter) throw new Error('Ethereal SMTP is not configured. Set ETHEREAL_SMTP_USER and ETHEREAL_SMTP_PASSWORD.');

  const reservation = await reserveSendSlot(
    redisForRateLimit,
    campaign.senderId,
    Math.min(campaign.hourlyLimit, campaign.sender.hourlyLimit),
    campaign.delayBetweenSeconds,
  );

  if (!reservation.allowed) {
    if (reservation.reason === 'hourly') {
      await notifyHourlyLimit(campaign.senderId, reservation.windowStart);
    }
    const reason = reservation.reason === 'hourly' ? 'HOURLY_LIMIT' : 'MINIMUM_DELAY';
    await deferJob(job, token, new Date(Date.now() + reservation.retryAfterMs), reason);
    return;
  }

  const attemptNumber = emailJob.attemptNumber + 1;
  const claimed = await prisma.$transaction(async (transaction) => {
    const update = await transaction.emailJob.updateMany({
      where: {
        id: emailJob.id,
        status: { in: pendingStatuses },
        scheduledFor: emailJob.scheduledFor,
      },
      data: { status: 'PROCESSING', attemptNumber, errorMessage: null, deferredReason: null },
    });
    if (update.count === 0) return false;
    await transaction.emailCampaign.update({ where: { id: campaign.id }, data: { status: 'PROCESSING' } });
    await transaction.emailAttempt.create({ data: { emailJobId: emailJob.id, attemptNumber } });
    return true;
  });
  if (!claimed) {
    const latest = await prisma.emailJob.findUnique({
      where: { id: emailJob.id },
      select: { status: true, scheduledFor: true },
    });
    if (latest && pendingStatuses.includes(latest.status)) {
      await deferJob(job, token, latest.scheduledFor, 'SCHEDULED_START');
    }
    return;
  }
  await safelyIndexEmailJob(emailJob.id);

  let info: SentMessageInfo;
  try {
    info = await transporter.sendMail({
      from: { name: campaign.sender.name, address: campaign.sender.email },
      to: recipientEmail,
      cc: campaign.ccRecipients,
      bcc: campaign.bccRecipients,
      subject: campaign.subject,
      html: campaign.body,
      text: messageHtmlToText(campaign.body),
      attachments: campaign.attachments.map((attachment) => ({
        filename: attachment.fileName,
        content: Buffer.from(attachment.content),
        contentType: attachment.contentType,
        ...(attachment.inline && attachment.contentId ? { cid: attachment.contentId, contentDisposition: 'inline' as const } : {}),
      })),
    });
  } catch (error) {
    await prisma.$transaction([
      prisma.emailAttempt.updateMany({
        where: { emailJobId: emailJob.id, attemptNumber, completedAt: null },
        data: { completedAt: new Date(), errorMessage: error instanceof Error ? error.message : 'SMTP attempt failed.' },
      }),
      prisma.emailJob.update({
        where: { id: emailJob.id },
        data: { status: 'QUEUED', errorMessage: error instanceof Error ? error.message : 'SMTP attempt failed.', deferredReason: null },
      }),
    ]);
    await safelyIndexEmailJob(emailJob.id);
    throw error;
  }

  const previewUrl = nodemailer.getTestMessageUrl(info);
  const etherealPreviewUrl = typeof previewUrl === 'string' ? previewUrl : null;
  await prisma.$transaction([
    prisma.emailAttempt.update({
      where: { emailJobId_attemptNumber: { emailJobId: emailJob.id, attemptNumber } },
      data: { completedAt: new Date(), accepted: true, smtpMessageId: info.messageId, previewUrl: etherealPreviewUrl },
    }),
    prisma.emailJob.update({
      where: { id: emailJob.id },
      data: { status: 'SENT', sentAt: new Date(), etherealPreviewUrl, deferredReason: null },
    }),
    prisma.emailCampaign.update({ where: { id: campaign.id }, data: { sentCount: { increment: 1 } } }),
  ]);
  await safelyIndexEmailJob(emailJob.id);
  await refreshCampaignStatus(campaign.id);
}

async function refreshCampaignStatus(campaignId: string): Promise<void> {
  const remaining = await prisma.emailJob.count({
    where: { campaignId, status: { in: ['SCHEDULED', 'QUEUED', 'PROCESSING', 'DEFERRED'] } },
  });
  if (remaining > 0) return;

  const unsuccessful = await prisma.emailJob.count({ where: { campaignId, status: { in: ['FAILED', 'UNKNOWN'] } } });
  const cancelled = await prisma.emailJob.count({ where: { campaignId, status: 'CANCELLED' } });
  const totalRecipients = await prisma.emailJob.count({ where: { campaignId } });
  await prisma.emailCampaign.update({
    where: { id: campaignId },
    data: { status: cancelled === totalRecipients ? 'CANCELLED' : unsuccessful > 0 ? 'FAILED' : 'COMPLETED' },
  });
}

export async function markUnknownOutcome(emailJobId: string, message: string): Promise<void> {
  const emailJob = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    select: { campaignId: true, status: true },
  });
  if (!emailJob || ['SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(emailJob.status)) return;

  const updated = await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: 'PROCESSING' },
    data: { status: 'UNKNOWN', errorMessage: message },
  });
  if (updated.count === 0) return;
  await safelyIndexEmailJob(emailJobId);
  await refreshCampaignStatus(emailJob.campaignId);
}

export async function markFinalFailure(emailJobId: string, error: Error): Promise<void> {
  const current = await prisma.emailJob.findUnique({ where: { id: emailJobId }, select: { campaignId: true } });
  if (!current) return;

  const updated = await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: { notIn: ['SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'] } },
    data: { status: 'FAILED', errorMessage: error.message },
  });
  if (updated.count === 0) return;

  await prisma.emailCampaign.update({ where: { id: current.campaignId }, data: { failedCount: { increment: 1 } } });
  await safelyIndexEmailJob(emailJobId);
  await refreshCampaignStatus(current.campaignId);
}

export const workerPrisma = prisma;
const redisUrl = new URL(process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`);
const redisForRateLimit = new Redis({
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});
export const workerRedis = redisForRateLimit;
