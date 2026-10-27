import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { evaluationProfiles } from './schema.js';

const migrationPath = fileURLToPath(
  new URL('../../../drizzle/0011_evaluation_profiles.sql', import.meta.url),
);
const migrationSql = readFileSync(migrationPath, 'utf8');

describe('evaluation profile persistence migration', () => {
  it('creates guide-independent mutable profiles and one explicit default', () => {
    expect(migrationSql).toContain('CREATE TABLE "app"."evaluation_profiles"');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "evaluation_profiles_name_unique"');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "evaluation_profiles_one_default"');
    expect(migrationSql).toContain("VALUES ('application', 12, now())");
    expect(migrationSql).not.toContain('guide_id');
    expect(migrationSql).not.toContain('locale');
  });

  it('matches the Drizzle primary-key and uniqueness model', () => {
    const config = getTableConfig(evaluationProfiles);

    expect(config.columns.find((column) => column.primary)?.name).toBe('profile_id');
    expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
      expect.arrayContaining([
        'evaluation_profiles_name_unique',
        'evaluation_profiles_one_default',
      ]),
    );
    expect(config.foreignKeys).toHaveLength(0);
  });
});
