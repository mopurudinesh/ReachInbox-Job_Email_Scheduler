import './load-env.js';
import { prisma } from './db.js';
import { rebuildEmailIndex } from './search-index.js';

async function main(): Promise<void> {
  try {
    const count = await rebuildEmailIndex();
    console.log(`Reindexed ${count} email records from PostgreSQL.`);
  } catch {
    console.error('Elasticsearch reindex failed. Check Elasticsearch connectivity and API logs.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
