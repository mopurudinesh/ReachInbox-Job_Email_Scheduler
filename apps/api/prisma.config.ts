import dotenv from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Prisma CLI runs from apps/api in workspace scripts. The application's .env
// lives at the monorepo root, so load that file explicitly for CLI commands.
dotenv.config({ path: '../../.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
