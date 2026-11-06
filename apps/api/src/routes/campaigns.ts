import { Router, type Request, type Response } from 'express';
import { ComposeEmailSchema } from '@reachinbox/shared';
import { prisma } from '../db.js';
import { enqueueEmailJob } from '../email-queue.js';
import { asyncHandler } from '../http.js';
import { indexEmailJob } from '../search-index.js';
import { sanitizeMessageHtml } from '../email-html.js';
import { messageHtmlToText } from '@reachinbox/shared';
import { fingerprintRequest, isUniqueConstraintError, isValidIdempotencyKey } from '../idempotency.js';

const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const campaigns = await prisma.emailCampaign.findMany({
    where: { userId: req.user!.id, ...(status ? { status } : {}) },
    include: { sender: true, _count: { select: { jobs: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: campaigns });
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!isValidIdempotencyKey(idempotencyKey)) {
    res.status(400).json({ success: false, error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'A valid Idempotency-Key header is required.' } });
    return;
  }

  const parsed = ComposeEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Check the email details and recipients.', details: parsed.error.flatten() } });
    return;
  }

  const input = parsed.data;
  const requestHash = fingerprintRequest(input);
  const existingRequest = await prisma.campaignIdempotency.findUnique({
    where: { userId_key: { userId: req.user!.id, key: idempotencyKey } },
  });
  if (existingRequest) {
    await replayCampaignRequest(existingRequest, requestHash, res);
    return;
  }

  const scheduledAt = new Date(input.scheduledAt);
  if (scheduledAt.getTime() < Date.now() - 60_000) {
    res.status(400).json({ success: false, error: { code: 'SCHEDULE_IN_PAST', message: 'Choose a start time in the future.' } });
    return;
  }

  const recipients = [...new Set(input.recipients.map((email) => email.toLowerCase()))];
  const recipientSet = new Set(recipients);
  const ccRecipients = [...new Set(input.ccRecipients.map((email) => email.toLowerCase()))].filter((email) => !recipientSet.has(email));
  const ccSet = new Set(ccRecipients);
  const bccRecipients = [...new Set(input.bccRecipients.map((email) => email.toLowerCase()))].filter((email) => !recipientSet.has(email) && !ccSet.has(email));
  const body = sanitizeMessageHtml(input.body);
  if (!messageHtmlToText(body)) {
    res.status(400).json({ success: false, error: { code: 'EMPTY_MESSAGE', message: 'Write some message text before scheduling.' } });
    return;
  }
  const attachments = input.attachments.map((attachment) => {
    const content = Buffer.from(attachment.contentBase64, 'base64');
    return {
      fileName: attachment.fileName.replace(/[\\/\u0000-\u001f]/g, '_'),
      contentType: attachment.contentType,
      size: attachment.size,
      content,
      inline: attachment.inline,
      contentId: attachment.contentId,
    };
  });
  if (attachments.some((attachment) => attachment.content.byteLength !== attachment.size)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_ATTACHMENT', message: 'One of the selected files could not be validated. Attach the file again.' } });
    return;
  }
  const sender = await prisma.senderAccount.findFirst({
    where: { id: input.senderId, userId: req.user!.id, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!sender) {
    res.status(400).json({ success: false, error: { code: 'SENDER_UNAVAILABLE', message: 'Choose an active sender account.' } });
    return;
  }

  let campaign: { id: string; jobs: { id: string; scheduledFor: Date }[] };
  try {
    campaign = await prisma.$transaction(async (transaction) => {
      const createdCampaign = await transaction.emailCampaign.create({
        data: {
          userId: req.user!.id,
          senderId: sender.id,
          subject: input.subject,
          body,
          ccRecipients,
          bccRecipients,
          scheduledAt,
          delayBetweenSeconds: input.delayBetweenSeconds,
          hourlyLimit: input.hourlyLimit,
          totalRecipients: recipients.length,
          jobs: {
            create: recipients.map((recipientEmail, index) => ({
              recipientEmail,
              scheduledFor: new Date(scheduledAt.getTime() + index * input.delayBetweenSeconds * 1000),
            })),
          },
          attachments: { create: attachments },
        },
        include: { jobs: { select: { id: true, scheduledFor: true } } },
      });

      await transaction.campaignIdempotency.create({
        data: {
          userId: req.user!.id,
          key: idempotencyKey,
          requestHash,
          campaignId: createdCampaign.id,
          recipientCount: recipients.length,
        },
      });
      return createdCampaign;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentRequest = await prisma.campaignIdempotency.findUnique({
      where: { userId_key: { userId: req.user!.id, key: idempotencyKey } },
    });
    if (!concurrentRequest) throw error;
    await replayCampaignRequest(concurrentRequest, requestHash, res);
    return;
  }

  let queuedCount = 0;
  for (const job of campaign.jobs) {
    try {
      await enqueueEmailJob(job.id, job.scheduledFor);
      queuedCount += 1;
    } catch {
      // The PostgreSQL outbox record remains SCHEDULED; worker startup reconciliation retries it.
    }
  }
  await Promise.all(campaign.jobs.map((job) => indexEmailJob(job.id).catch(() => undefined)));

  res.status(201).json({
    success: true,
    data: {
      campaignId: campaign.id,
      recipientCount: recipients.length,
      queuedCount,
      queueState: queuedCount === recipients.length ? 'queued' : 'pending_reconciliation',
    },
  });
}));

async function replayCampaignRequest(
  existing: { requestHash: string; campaignId: string; recipientCount: number },
  requestHash: string,
  res: Response,
): Promise<void> {
  if (existing.requestHash !== requestHash) {
    res.status(409).json({ success: false, error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for different email details.' } });
    return;
  }

  const pendingJobs = await prisma.emailJob.findMany({
    where: {
      campaignId: existing.campaignId,
      status: { in: ['SCHEDULED', 'QUEUED', 'DEFERRED'] },
    },
    select: { id: true, scheduledFor: true },
  });
  let queuedCount = 0;
  for (const job of pendingJobs) {
    try {
      await enqueueEmailJob(job.id, job.scheduledFor);
      queuedCount += 1;
    } catch {
      // The persisted outbox row remains available for worker reconciliation.
    }
  }

  res.status(200).json({
    success: true,
    data: {
      campaignId: existing.campaignId,
      recipientCount: existing.recipientCount,
      queuedCount,
      queueState: queuedCount === pendingJobs.length ? 'queued' : 'pending_reconciliation',
      replayed: true,
    },
  });
}

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: {
      sender: true,
      jobs: { orderBy: { scheduledFor: 'asc' } },
      attachments: { select: { id: true, fileName: true, contentType: true, size: true } },
    },
  });
  if (!campaign) {
    res.status(404).json({ success: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign was not found.' } });
    return;
  }
  res.json({
    success: true,
    data: { ...campaign, jobs: campaign.jobs.map((job) => ({ ...job, scheduledAt: job.scheduledFor })) },
  });
}));

export default router;
