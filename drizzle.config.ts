import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/backend/src/infrastructure/database/schema.ts',
  out: './apps/backend/drizzle',
  schemaFilter: ['app'],
  strict: true,
  verbose: true,
});
