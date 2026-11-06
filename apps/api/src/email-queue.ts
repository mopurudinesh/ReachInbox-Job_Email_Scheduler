import { Queue } from 'bullmq';
import { prisma } from './db.js';

export const EMAIL_QUEUE_NAME = 'email-delivery';

const redisUrl = new URL(process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, { connection });

export async function enqueueEmailJob(emailJobId: string, scheduledFor: Date): Promise<void> {
  const delay = Math.max(0, scheduledFor.getTime() - Date.now());
  await emailQueue.add('deliver-email', { emailJobId }, {
    jobId: emailJobId,
    delay,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 1_000,
  });

  await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: { in: ['SCHEDULED', 'DEFERRED'] } },
    data: { status: 'QUEUED' },
  });
}
