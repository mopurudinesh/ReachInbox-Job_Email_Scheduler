import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as typeof globalThis & {
  reachInboxPrisma?: PrismaClient;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to connect to PostgreSQL.');

const adapter = new PrismaPg({ connectionString });
export const prisma = globalForPrisma.reachInboxPrisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.reachInboxPrisma = prisma;
}
