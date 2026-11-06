import { Client, type estypes } from '@elastic/elasticsearch';
import { prisma } from './db.js';
import { messageHtmlToText, type EmailSearchDocument } from '@reachinbox/shared';

export const EMAIL_SEARCH_INDEX = 'reachinbox-emails';

export const elasticsearch = new Client({
  node: process.env.ELASTICSEARCH_NODE || 'http://localhost:9200',
  requestTimeout: 5000,
  maxRetries: 1,
});

let ensureIndexPromise: Promise<void> | null = null;

export function ensureEmailIndex(): Promise<void> {
  ensureIndexPromise ??= createEmailIndex();
  return ensureIndexPromise.catch((error: unknown) => {
    ensureIndexPromise = null;
    throw error;
  });
}

async function createEmailIndex(): Promise<void> {
  const exists = await elasticsearch.indices.exists({ index: EMAIL_SEARCH_INDEX });
  if (exists) return;

  try {
    await elasticsearch.indices.create({
      index: EMAIL_SEARCH_INDEX,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          userId: { type: 'keyword' },
          campaignId: { type: 'keyword' },
          recipientEmail: { type: 'keyword' },
          senderEmail: { type: 'keyword' },
          senderName: { type: 'text' },
          subject: { type: 'text' },
          bodyText: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
          errorMessage: { type: 'text' },
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('resource_already_exists_exception')) throw error;
  }
}

export async function indexEmailJob(emailJobId: string): Promise<void> {
  const emailJob = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { campaign: { include: { sender: true } } },
  });
  if (!emailJob) return;

  await ensureEmailIndex();
  const document: EmailSearchDocument = {
    id: emailJob.id,
    userId: emailJob.campaign.userId,
    campaignId: emailJob.campaignId,
    recipientEmail: emailJob.recipientEmail,
    senderEmail: emailJob.campaign.sender.email,
    senderName: emailJob.campaign.sender.name,
    subject: emailJob.campaign.subject,
    bodyText: messageHtmlToText(emailJob.campaign.body),
    status: emailJob.status as EmailSearchDocument['status'],
    scheduledAt: emailJob.scheduledFor.toISOString(),
    sentAt: emailJob.sentAt?.toISOString() ?? null,
    errorMessage: emailJob.errorMessage,
  };
  await elasticsearch.index({ index: EMAIL_SEARCH_INDEX, id: emailJob.id, document });
}

export async function deleteEmailJobsFromIndex(emailJobIds: string[]): Promise<void> {
  if (emailJobIds.length === 0) return;
  await ensureEmailIndex();
  const operations: estypes.BulkOperationContainer[] = emailJobIds.map((id) => ({
    delete: { _index: EMAIL_SEARCH_INDEX, _id: id },
  }));
  const result = await elasticsearch.bulk({ operations });
  const failedItems = result.items.filter((item) => {
    const operation = Object.values(item)[0];
    return operation && operation.status >= 300 && operation.status !== 404;
  });
  if (failedItems.length > 0) {
    throw new Error(`Elasticsearch could not remove ${failedItems.length} email history records.`);
  }
}

export async function searchEmails(userId: string, queryText: string, status?: string): Promise<EmailSearchDocument[]> {
  await ensureEmailIndex();
  const filters: estypes.QueryDslQueryContainer[] = [{ term: { userId } }];
  if (status) filters.push({ term: { status } });

  const result = await elasticsearch.search<EmailSearchDocument>({
    index: EMAIL_SEARCH_INDEX,
    size: 50,
    query: {
      bool: {
        filter: filters,
        must: [{
          multi_match: {
            query: queryText,
            fields: ['subject^3', 'recipientEmail', 'senderEmail', 'status', 'bodyText'],
            type: 'best_fields',
            operator: 'and',
          },
        }],
      },
    },
    sort: [{ scheduledAt: { order: 'desc' } }],
  });
  return result.hits.hits.flatMap((hit) => hit._source ? [hit._source] : []);
}

export async function rebuildEmailIndex(): Promise<number> {
  const exists = await elasticsearch.indices.exists({ index: EMAIL_SEARCH_INDEX });
  if (exists) await elasticsearch.indices.delete({ index: EMAIL_SEARCH_INDEX });
  await ensureEmailIndex();

  let cursor: string | undefined;
  let indexed = 0;
  while (true) {
    const jobs = await prisma.emailJob.findMany({
      include: { campaign: { include: { sender: true } } },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (jobs.length === 0) break;

    const operations = jobs.flatMap((job) => {
      cursor = job.id;
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
      return [{ index: { _index: EMAIL_SEARCH_INDEX, _id: job.id } }, document];
    });
    const result = await elasticsearch.bulk({ operations, refresh: false });
    if (result.errors) throw new Error('Elasticsearch reported errors during reindexing.');
    indexed += jobs.length;
  }
  await elasticsearch.indices.refresh({ index: EMAIL_SEARCH_INDEX });
  return indexed;
}
