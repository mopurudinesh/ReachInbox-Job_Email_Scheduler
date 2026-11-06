import './load-env.js';
import { Queue, Worker } from 'bullmq';
import { markFinalFailure, markUnknownOutcome, processEmail, workerPrisma, workerRedis } from './processor.js';

const EMAIL_QUEUE_NAME = 'email-delivery';

const redisUrl = new URL(process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`);
const connectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 5));
const queue = new Queue(EMAIL_QUEUE_NAME, { connection: connectionOptions });

const worker = new Worker(EMAIL_QUEUE_NAME, processEmail, {
  connection: connectionOptions,
  concurrency,
  autorun: false,
});

async function reconcileOutbox(): Promise<void> {
  let cursor: string | undefined;
  let reconciled = 0;

  while (true) {
    const outboxJobs = await workerPrisma.emailJob.findMany({
      where: { status: { in: ['SCHEDULED', 'QUEUED', 'DEFERRED', 'PROCESSING'] } },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (outboxJobs.length === 0) break;

    for (const emailJob of outboxJobs) {
      reconciled += 1;
      cursor = emailJob.id;
    const queueJob = await queue.getJob(emailJob.id);
    if (emailJob.status === 'PROCESSING') {
      if (!queueJob) {
        await markUnknownOutcome(emailJob.id, 'Worker restarted before recording the SMTP outcome; check the Ethereal mailbox before retrying.');
      } else if (await queueJob.getState() === 'completed') {
        await markUnknownOutcome(emailJob.id, 'Queue job completed without a recorded delivery result; check the Ethereal mailbox before retrying.');
      }
      continue;
    }

    if (queueJob) {
      const state = await queueJob.getState();
      if (state === 'failed') {
        if (queueJob.attemptsMade >= (queueJob.opts.attempts || 1)) {
          await markFinalFailure(emailJob.id, queueJob.failedReason ? new Error(queueJob.failedReason) : new Error('Delivery failed.'));
          continue;
        }
        await queueJob.remove();
      } else if (state !== 'completed') {
        continue;
      } else if (emailJob.status !== 'SENT') {
        await markUnknownOutcome(emailJob.id, 'Queue job completed without a sent record; check the Ethereal mailbox before retrying.');
        continue;
      } else {
        continue;
      }
    }

    await queue.add('deliver-email', { emailJobId: emailJob.id }, {
      jobId: emailJob.id,
      delay: Math.max(0, emailJob.scheduledFor.getTime() - Date.now()),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    });
    await workerPrisma.emailJob.update({ where: { id: emailJob.id }, data: { status: 'QUEUED' } });
    }
  }
  console.log(`[ReachInbox Worker] Reconciled ${reconciled} durable email records.`);
}

worker.on('completed', (job) => {
  console.log(`[ReachInbox Worker] Email job ${job.id} completed.`);
});

worker.on('failed', (job, error) => {
  if (!job) return;
  console.error(`[ReachInbox Worker] Email job ${job.id} failed on attempt ${job.attemptsMade}.`);
  if (job.attemptsMade >= (job.opts.attempts || 1)) {
    void markFinalFailure(job.data.emailJobId, error).catch(() => {
      console.error(`[ReachInbox Worker] Could not record final failure for ${job.id}.`);
    });
  }
});

worker.on('error', () => {
  console.error('[ReachInbox Worker] Queue connection or processing error.');
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[ReachInbox Worker] Received ${signal}; closing worker.`);
  await worker.close();
  await queue.close();
  await workerRedis.quit();
  await workerPrisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void reconcileOutbox()
  .then(() => {
    console.log(`[ReachInbox Worker] Listening with concurrency ${concurrency}.`);
    void worker.run();
  })
  .catch((error: unknown) => {
    if (process.env.NODE_ENV === 'production') {
      console.error('[ReachInbox Worker] Startup reconciliation failed.');
    } else {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[ReachInbox Worker] Startup reconciliation failed: ${reason}`);
    }
    process.exitCode = 1;
  });
