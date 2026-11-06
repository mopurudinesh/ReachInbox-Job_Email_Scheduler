import { Router, type Request, type Response } from 'express';
import { CreateSenderSchema, RescheduleEmailSchema } from '@reachinbox/shared';
import { prisma } from '../db.js';
import { emailQueue, enqueueEmailJob } from '../email-queue.js';
import { asyncHandler } from '../http.js';
import { deleteEmailJobsFromIndex, indexEmailJob } from '../search-index.js';

const router = Router();
const pendingStatuses = ['SCHEDULED', 'QUEUED', 'DEFERRED'];
const historyStatuses = ['SENT', 'FAILED', 'CANCELLED', 'UNKNOWN'];

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const senders = await prisma.senderAccount.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: senders });
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateSenderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Check the sender details.', details: parsed.error.flatten() } });
    return;
  }

  const sender = await prisma.senderAccount.upsert({
    where: { userId_email: { userId: req.user!.id, email: parsed.data.email } },
    create: { ...parsed.data, userId: req.user!.id },
    update: { name: parsed.data.name, hourlyLimit: parsed.data.hourlyLimit, status: 'ACTIVE' },
  });
  res.status(201).json({ success: true, data: sender });
}));

router.patch('/:id/disconnect', asyncHandler(async (req: Request, res: Response) => {
  const result = await prisma.senderAccount.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { status: 'DISCONNECTED' },
  });
  if (result.count === 0) {
    res.status(404).json({ success: false, error: { code: 'SENDER_NOT_FOUND', message: 'Sender account was not found.' } });
    return;
  }
  res.json({ success: true, data: { disconnected: true } });
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const sender = await prisma.senderAccount.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true },
  });
  if (!sender) {
    res.status(404).json({ success: false, error: { code: 'SENDER_NOT_FOUND', message: 'Sender account was not found.' } });
    return;
  }

  const jobs = await prisma.emailJob.findMany({
    where: { campaign: { userId: req.user!.id, senderId: sender.id } },
    select: { id: true, status: true, scheduledFor: true },
  });
  if (jobs.some(({ status }) => status === 'PROCESSING')) {
    res.status(409).json({
      success: false,
      error: { code: 'SENDER_HAS_ACTIVE_EMAILS', message: 'This sender cannot be deleted while an email is being sent. Try again after the active send finishes.' },
    });
    return;
  }

  const removedQueueJobIds = new Set<string>();
  let activeQueueJobs = 0;
  let queueFailures = 0;
  for (const job of jobs) {
    try {
      const queueJob = await emailQueue.getJob(job.id);
      if (!queueJob) continue;
      if (await queueJob.getState() === 'active') {
        activeQueueJobs += 1;
        continue;
      }
      await queueJob.remove();
      removedQueueJobIds.add(job.id);
    } catch {
      queueFailures += 1;
    }
  }

  async function restoreSenderRecords() {
    const removedPendingJobs = jobs.filter(({ id, status }) => removedQueueJobIds.has(id) && pendingStatuses.includes(status));
    const queueRestores = await Promise.allSettled(removedPendingJobs.map(({ id, scheduledFor }) => enqueueEmailJob(id, scheduledFor)));
    const indexRestores = await Promise.allSettled(jobs.map(({ id }) => indexEmailJob(id)));
    return queueRestores.filter(({ status }) => status === 'rejected').length
      + indexRestores.filter(({ status }) => status === 'rejected').length;
  }

  if (activeQueueJobs > 0 || queueFailures > 0) {
    const restoreFailures = await restoreSenderRecords();
    const restorationWarning = restoreFailures
      ? ` ${restoreFailures} queue/search restoration operation${restoreFailures === 1 ? ' failed.' : 's failed.'}`
      : '';
    if (activeQueueJobs > 0) {
      res.status(409).json({
        success: false,
        error: {
          code: 'SENDER_HAS_ACTIVE_EMAILS',
          message: `This sender cannot be deleted while ${activeQueueJobs} email${activeQueueJobs === 1 ? ' is' : 's are'} active. Try again after delivery finishes.${restorationWarning}`,
        },
      });
    } else {
      res.status(503).json({
        success: false,
        error: {
          code: 'SENDER_QUEUE_CLEANUP_REQUIRED',
          message: `The sender was not deleted because ${queueFailures} queue entries could not be removed.${restorationWarning || ' Existing email records were restored.'}`,
        },
      });
    }
    return;
  }

  try {
    await deleteEmailJobsFromIndex(jobs.map(({ id }) => id));
  } catch {
    const restoreFailures = await restoreSenderRecords();
    res.status(503).json({
      success: false,
      error: {
        code: 'SENDER_SEARCH_CLEANUP_REQUIRED',
        message: `The sender was not deleted because its email search records could not be removed.${restoreFailures ? ` ${restoreFailures} queue/search restoration operation${restoreFailures === 1 ? ' failed.' : 's failed.'}` : ' Existing email records were restored.'}`,
      },
    });
    return;
  }

  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.emailJob.updateMany({
        where: {
          status: { in: pendingStatuses },
          campaign: { userId: req.user!.id, senderId: sender.id },
        },
        data: { status: 'CANCELLED' },
      });
      const activeCount = await transaction.emailJob.count({
        where: { status: 'PROCESSING', campaign: { userId: req.user!.id, senderId: sender.id } },
      });
      if (activeCount > 0) throw new Error('SENDER_HAS_ACTIVE_EMAILS');

      const campaigns = await transaction.emailCampaign.findMany({
        where: { userId: req.user!.id, senderId: sender.id },
        select: { id: true },
      });
      const campaignIds = campaigns.map(({ id }) => id);
      if (campaignIds.length > 0) {
        await transaction.campaignIdempotency.deleteMany({ where: { userId: req.user!.id, campaignId: { in: campaignIds } } });
        await transaction.emailCampaign.deleteMany({ where: { id: { in: campaignIds }, userId: req.user!.id } });
      }
      await transaction.senderAccount.delete({ where: { id: sender.id } });
    });
  } catch (reason) {
    const restoreFailures = await restoreSenderRecords();
    if (reason instanceof Error && reason.message === 'SENDER_HAS_ACTIVE_EMAILS') {
      res.status(409).json({
        success: false,
        error: {
          code: 'SENDER_HAS_ACTIVE_EMAILS',
          message: `This sender cannot be deleted while an email is being sent.${restoreFailures ? ` ${restoreFailures} queue/search restoration operation${restoreFailures === 1 ? ' failed.' : 's failed.'}` : ' Existing email records were restored.'}`,
        },
      });
      return;
    }
    throw reason;
  }

  res.json({ success: true, data: { deleted: true } });
}));

router.post('/:id/scheduled/reschedule', asyncHandler(async (req: Request, res: Response) => {
  const parsed = RescheduleEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Choose a valid future time.' } });
    return;
  }

  const scheduledFor = new Date(parsed.data.scheduledAt);
  if (scheduledFor.getTime() <= Date.now() + 1000) {
    res.status(400).json({ success: false, error: { code: 'SCHEDULE_IN_PAST', message: 'Choose a time at least one second in the future.' } });
    return;
  }

  const sender = await prisma.senderAccount.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true },
  });
  if (!sender) {
    res.status(404).json({ success: false, error: { code: 'SENDER_NOT_FOUND', message: 'Sender account was not found.' } });
    return;
  }

  const candidates = await prisma.emailJob.findMany({
    where: { status: { in: pendingStatuses }, campaign: { userId: req.user!.id, senderId: sender.id } },
    select: { id: true },
  });
  if (candidates.length === 0) {
    res.json({ success: true, data: { updatedCount: 0, queuedCount: 0 } });
    return;
  }

  const ids = candidates.map(({ id }) => id);
  const updated = await prisma.emailJob.updateMany({
    where: { id: { in: ids }, status: { in: pendingStatuses } },
    data: { status: 'SCHEDULED', scheduledFor, deferredReason: null, errorMessage: null },
  });

  const jobs = await prisma.emailJob.findMany({
    where: { id: { in: ids }, status: { in: pendingStatuses }, scheduledFor },
    select: { id: true },
  });
  let queuedCount = 0;
  let activeCount = 0;
  let queueFailures = 0;
  for (const job of jobs) {
    try {
      const queueJob = await emailQueue.getJob(job.id);
      if (queueJob) {
        if (await queueJob.getState() === 'active') {
          activeCount += 1;
          continue;
        }
        await queueJob.remove();
      }
      await enqueueEmailJob(job.id, scheduledFor);
      queuedCount += 1;
    } catch {
      queueFailures += 1;
    }
  }

  await Promise.all(jobs.map(({ id }) => indexEmailJob(id).catch(() => undefined)));
  if (queueFailures > 0) {
    res.status(503).json({
      success: false,
      error: {
        code: 'QUEUE_RECONCILIATION_REQUIRED',
        message: `The new time was saved for ${updated.count} emails, but the delivery queue could not be updated for ${queueFailures}. Refresh the list before trying again.`,
      },
    });
    return;
  }
  res.json({ success: true, data: { updatedCount: updated.count, queuedCount, activeCount } });
}));

router.delete('/:id/scheduled', asyncHandler(async (req: Request, res: Response) => {
  const sender = await prisma.senderAccount.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true },
  });
  if (!sender) {
    res.status(404).json({ success: false, error: { code: 'SENDER_NOT_FOUND', message: 'Sender account was not found.' } });
    return;
  }

  const candidates = await prisma.emailJob.findMany({
    where: { status: { in: pendingStatuses }, campaign: { userId: req.user!.id, senderId: sender.id } },
    select: { id: true, campaignId: true },
  });
  if (candidates.length === 0) {
    res.json({ success: true, data: { cancelledCount: 0 } });
    return;
  }

  const ids = candidates.map(({ id }) => id);
  const cancelled = await prisma.emailJob.updateMany({
    where: { id: { in: ids }, status: { in: pendingStatuses } },
    data: { status: 'CANCELLED', deferredReason: null, errorMessage: null },
  });
  const cancelledJobs = await prisma.emailJob.findMany({
    where: { id: { in: ids }, status: 'CANCELLED' },
    select: { id: true },
  });

  let queueFailures = 0;
  for (const job of cancelledJobs) {
    try {
      const queueJob = await emailQueue.getJob(job.id);
      if (queueJob && await queueJob.getState() !== 'active') {
        await queueJob.remove();
      }
    } catch {
      queueFailures += 1;
    }
  }
  await Promise.all(cancelledJobs.map(({ id }) => indexEmailJob(id).catch(() => undefined)));

  for (const campaignId of new Set(candidates.map(({ campaignId }) => campaignId))) {
    const remaining = await prisma.emailJob.count({
      where: { campaignId, status: { in: [...pendingStatuses, 'PROCESSING'] } },
    });
    if (remaining > 0) continue;

    const [total, cancelledCount, failures] = await Promise.all([
      prisma.emailJob.count({ where: { campaignId } }),
      prisma.emailJob.count({ where: { campaignId, status: 'CANCELLED' } }),
      prisma.emailJob.count({ where: { campaignId, status: { in: ['FAILED', 'UNKNOWN'] } } }),
    ]);
    await prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { status: cancelledCount === total ? 'CANCELLED' : failures > 0 ? 'FAILED' : 'COMPLETED' },
    });
  }

  if (queueFailures > 0) {
    res.status(503).json({
      success: false,
      error: {
        code: 'CANCEL_QUEUE_CLEANUP_REQUIRED',
        message: `Cancellation was saved for ${cancelled.count} emails, but queue cleanup failed for ${queueFailures}. Workers will skip cancelled emails; refresh the list before trying again.`,
      },
    });
    return;
  }
  res.json({ success: true, data: { cancelledCount: cancelled.count } });
}));

router.delete('/:id/history', asyncHandler(async (req: Request, res: Response) => {
  const sender = await prisma.senderAccount.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true },
  });
  if (!sender) {
    res.status(404).json({ success: false, error: { code: 'SENDER_NOT_FOUND', message: 'Sender account was not found.' } });
    return;
  }

  const candidates = await prisma.emailJob.findMany({
    where: {
      status: { in: historyStatuses },
      campaign: { userId: req.user!.id, senderId: sender.id },
    },
    select: { id: true, campaignId: true },
  });
  if (candidates.length === 0) {
    res.json({ success: true, data: { clearedCount: 0, skippedActiveCount: 0 } });
    return;
  }

  const clearableIds: string[] = [];
  let skippedActiveCount = 0;
  let queueFailures = 0;
  for (const candidate of candidates) {
    try {
      const queueJob = await emailQueue.getJob(candidate.id);
      if (queueJob) {
        if (await queueJob.getState() === 'active') {
          skippedActiveCount += 1;
          continue;
        }
        await queueJob.remove();
      }
      clearableIds.push(candidate.id);
    } catch {
      queueFailures += 1;
    }
  }

  if (queueFailures > 0) {
    res.status(503).json({
      success: false,
      error: {
        code: 'HISTORY_QUEUE_CLEANUP_REQUIRED',
        message: `History was not cleared because ${queueFailures} queue entries could not be checked or removed. Try again.`,
      },
    });
    return;
  }

  try {
    await deleteEmailJobsFromIndex(clearableIds);
  } catch {
    res.status(503).json({
      success: false,
      error: {
        code: 'HISTORY_SEARCH_CLEANUP_REQUIRED',
        message: 'History was not cleared because search records could not be removed. Try again.',
      },
    });
    return;
  }

  const deleted = await prisma.$transaction(async (transaction) => {
    const result = await transaction.emailJob.deleteMany({
      where: {
        id: { in: clearableIds },
        status: { in: historyStatuses },
        campaign: { userId: req.user!.id, senderId: sender.id },
      },
    });

    for (const campaignId of new Set(candidates.filter(({ id }) => clearableIds.includes(id)).map(({ campaignId }) => campaignId))) {
      const campaign = await transaction.emailCampaign.findFirst({
        where: { id: campaignId, userId: req.user!.id, senderId: sender.id },
        select: { id: true, jobs: { select: { status: true } } },
      });
      if (!campaign) continue;
      if (campaign.jobs.length === 0) {
        await transaction.emailCampaign.delete({ where: { id: campaign.id } });
        continue;
      }

      const statuses = campaign.jobs.map(({ status }) => status);
      const sentCount = statuses.filter((status) => status === 'SENT').length;
      const failedCount = statuses.filter((status) => status === 'FAILED' || status === 'UNKNOWN').length;
      const hasActiveJobs = statuses.some((status) => [...pendingStatuses, 'PROCESSING'].includes(status));
      const cancelledCount = statuses.filter((status) => status === 'CANCELLED').length;
      const campaignStatus = hasActiveJobs
        ? undefined
        : cancelledCount === statuses.length
          ? 'CANCELLED'
          : failedCount > 0
            ? 'FAILED'
            : 'COMPLETED';

      await transaction.emailCampaign.update({
        where: { id: campaign.id },
        data: {
          totalRecipients: statuses.length,
          sentCount,
          failedCount,
          ...(campaignStatus ? { status: campaignStatus } : {}),
        },
      });
    }

    return result.count;
  });

  res.json({ success: true, data: { clearedCount: deleted, skippedActiveCount } });
}));

export default router;
