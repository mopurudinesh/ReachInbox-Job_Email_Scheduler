import { Router, type Request, type Response } from 'express';
import { RescheduleEmailSchema } from '@reachinbox/shared';
import { asyncHandler } from '../http.js';
import { prisma } from '../db.js';
import { emailQueue, enqueueEmailJob } from '../email-queue.js';
import { indexEmailJob } from '../search-index.js';

const router = Router();
const pendingStatuses = ['SCHEDULED', 'QUEUED', 'DEFERRED'];
const listStatuses: Record<string, string[]> = {
  scheduled: ['SCHEDULED', 'QUEUED', 'PROCESSING', 'DEFERRED'],
  sent: ['SENT', 'FAILED', 'UNKNOWN'],
  failed: ['FAILED', 'UNKNOWN'],
};

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const view = typeof req.query.view === 'string' ? req.query.view : '';
  const statuses = listStatuses[view];
  if (!statuses) {
    res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL_VIEW', message: 'Choose scheduled, sent, or failed emails.' } });
    return;
  }

  const jobs = await prisma.emailJob.findMany({
    where: { status: { in: statuses }, campaign: { userId: req.user!.id } },
    include: { campaign: { include: { sender: true } } },
    orderBy: [{ scheduledFor: view === 'scheduled' ? 'asc' : 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  res.json({ success: true, data: jobs.map((job) => ({
    id: job.id,
    campaignId: job.campaignId,
    recipientEmail: job.recipientEmail,
    senderEmail: job.campaign.sender.email,
    senderName: job.campaign.sender.name,
    subject: job.campaign.subject,
    bodyText: job.campaign.body,
    status: job.status,
    scheduledAt: job.scheduledFor,
    deferredReason: job.deferredReason,
    sentAt: job.sentAt,
    errorMessage: job.errorMessage,
    etherealPreviewUrl: job.etherealPreviewUrl,
  })) });
}));

router.patch('/:id/schedule', asyncHandler(async (req: Request, res: Response) => {
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

  const current = await prisma.emailJob.findFirst({
    where: { id: req.params.id, campaign: { userId: req.user!.id } },
    select: { id: true, campaignId: true, status: true, scheduledFor: true },
  });
  if (!current) {
    res.status(404).json({ success: false, error: { code: 'EMAIL_NOT_FOUND', message: 'Scheduled email was not found.' } });
    return;
  }
  if (!pendingStatuses.includes(current.status)) {
    res.status(409).json({ success: false, error: { code: 'EMAIL_NOT_RESCHEDULABLE', message: 'This email is already processing or has finished and cannot be rescheduled.' } });
    return;
  }

  const updated = await prisma.emailJob.updateMany({
    where: {
      id: current.id,
      campaign: { userId: req.user!.id },
      status: { in: pendingStatuses },
      scheduledFor: current.scheduledFor,
    },
    data: { status: 'SCHEDULED', scheduledFor, deferredReason: null, errorMessage: null },
  });
  if (updated.count === 0) {
    res.status(409).json({ success: false, error: { code: 'EMAIL_STATE_CHANGED', message: 'This email changed while you were editing it. Refresh the list and try again.' } });
    return;
  }

  const queueJob = await emailQueue.getJob(current.id);
  if (queueJob) {
    const state = await queueJob.getState();
    if (state !== 'active') {
      try { await queueJob.remove(); }
      catch { /* If it became active, the worker will see the updated database schedule before sending. */ }
    }
    if (state === 'active') {
      // The active worker compares the database schedule before claiming SMTP delivery and will defer itself.
    } else {
      await enqueueEmailJob(current.id, scheduledFor);
    }
  } else {
    await enqueueEmailJob(current.id, scheduledFor);
  }

  await indexEmailJob(current.id).catch(() => undefined);
  res.json({ success: true, data: { id: current.id, scheduledAt: scheduledFor } });
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const current = await prisma.emailJob.findFirst({
    where: { id: req.params.id, campaign: { userId: req.user!.id } },
    select: { id: true, campaignId: true, status: true, scheduledFor: true },
  });
  if (!current) {
    res.status(404).json({ success: false, error: { code: 'EMAIL_NOT_FOUND', message: 'Scheduled email was not found.' } });
    return;
  }
  if (!pendingStatuses.includes(current.status)) {
    res.status(409).json({ success: false, error: { code: 'EMAIL_NOT_CANCELLABLE', message: 'This email is already processing or has finished and cannot be cancelled.' } });
    return;
  }

  const cancelled = await prisma.emailJob.updateMany({
    where: {
      id: current.id,
      campaign: { userId: req.user!.id },
      status: { in: pendingStatuses },
      scheduledFor: current.scheduledFor,
    },
    data: { status: 'CANCELLED', deferredReason: null, errorMessage: null },
  });
  if (cancelled.count === 0) {
    res.status(409).json({ success: false, error: { code: 'EMAIL_STATE_CHANGED', message: 'This email changed while you were cancelling it. Refresh the list and try again.' } });
    return;
  }

  const queueJob = await emailQueue.getJob(current.id);
  if (queueJob) {
    try { await queueJob.remove(); }
    catch { /* A worker that already picked up the job will see CANCELLED before claiming SMTP delivery. */ }
  }
  await indexEmailJob(current.id).catch(() => undefined);

  const remaining = await prisma.emailJob.count({
    where: { campaignId: current.campaignId, status: { in: [...pendingStatuses, 'PROCESSING'] } },
  });
  if (remaining === 0) {
    const [total, cancelledCount, failures] = await Promise.all([
      prisma.emailJob.count({ where: { campaignId: current.campaignId } }),
      prisma.emailJob.count({ where: { campaignId: current.campaignId, status: 'CANCELLED' } }),
      prisma.emailJob.count({ where: { campaignId: current.campaignId, status: { in: ['FAILED', 'UNKNOWN'] } } }),
    ]);
    await prisma.emailCampaign.update({
      where: { id: current.campaignId },
      data: { status: cancelledCount === total ? 'CANCELLED' : failures > 0 ? 'FAILED' : 'COMPLETED' },
    });
  }

  res.json({ success: true, data: { cancelled: true } });
}));

export default router;
