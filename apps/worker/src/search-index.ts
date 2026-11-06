import { Client } from '@elastic/elasticsearch';
import { messageHtmlToText, type EmailSearchDocument } from '@reachinbox/shared';
import { prisma } from './db.js';

const INDEX = 'reachinbox-emails';
const client = new Client({ node: process.env.ELASTICSEARCH_NODE || 'http://localhost:9200', requestTimeout: 5000, maxRetries: 1 });

async function ensureIndex(): Promise<void> {
  const exists = await client.indices.exists({ index: INDEX });
  if (exists) return;
  try {
    await client.indices.create({
      index: INDEX,
      mappings: {
        properties: {
          id: { type: 'keyword' }, userId: { type: 'keyword' }, campaignId: { type: 'keyword' },
          recipientEmail: { type: 'keyword' }, senderEmail: { type: 'keyword' }, senderName: { type: 'text' },
          subject: { type: 'text' }, bodyText: { type: 'text' }, status: { type: 'keyword' },
          scheduledAt: { type: 'date' }, sentAt: { type: 'date' }, errorMessage: { type: 'text' },
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('resource_already_exists_exception')) throw error;
  }
}

export async function safelyIndexEmailJob(emailJobId: string): Promise<void> {
  try {
    const job = await prisma.emailJob.findUnique({
      where: { id: emailJobId },
      include: { campaign: { include: { sender: true } } },
    });
    if (!job) return;
    await ensureIndex();
    const document: EmailSearchDocument = {
      id: job.id,
      userId: job.campaign.userId,
      campaignId: job.campaignId,
      recipientEmail: job.recipientEmail,
      senderEmail: job.campaign.sender.email,
      senderName: job.campaign.sender.name,
      subject: job.campaign.subject,
      bodyText: messageHtmlToText(job.campaign.body),
      status: job.status as EmailSearchDocument['status'],
      scheduledAt: job.scheduledFor.toISOString(),
      sentAt: job.sentAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
    };
    await client.index({ index: INDEX, id: job.id, document });
  } catch {
    console.error('[ReachInbox Worker] Elasticsearch indexing failed; PostgreSQL remains authoritative.');
  }
}
