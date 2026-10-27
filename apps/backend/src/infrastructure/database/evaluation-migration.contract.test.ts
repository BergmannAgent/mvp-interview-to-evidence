import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { evaluationRuns } from './schema.js';

const legacyMigrationPath = fileURLToPath(
  new URL('../../../drizzle/0009_evaluation_persistence.sql', import.meta.url),
);
const legacyMigrationSql = readFileSync(legacyMigrationPath, 'utf8');
const profileMigrationPath = fileURLToPath(
  new URL('../../../drizzle/0012_profile_driven_evaluations.sql', import.meta.url),
);
const profileMigrationSql = readFileSync(profileMigrationPath, 'utf8');

describe('evaluation persistence migration', () => {
  it('retains the immutable historical evaluation migration', () => {
    expect(legacyMigrationSql).toContain('CREATE TABLE "app"."evaluation_rubrics"');
    expect(legacyMigrationSql).toContain('CREATE TABLE "app"."evaluation_runs"');
    expect(legacyMigrationSql).toContain(
      'CONSTRAINT "evaluation_rubrics_pk" PRIMARY KEY("rubric_id", "version")',
    );
    expect(legacyMigrationSql).toContain(
      'CONSTRAINT "evaluation_runs_source_unique" UNIQUE("interview_id", "rubric_fingerprint", "transcript_fingerprint")',
    );
    expect(legacyMigrationSql).toContain("VALUES ('application', 10, now())");
  });

  it('replaces only obsolete evaluation data with profile-driven runs', () => {
    expect(profileMigrationSql).toContain('DROP TABLE "app"."evaluation_runs"');
    expect(profileMigrationSql).toContain('DROP TABLE "app"."evaluation_rubrics"');
    expect(profileMigrationSql).toContain('CREATE TABLE "app"."evaluation_runs"');
    expect(profileMigrationSql).toContain(
      'CONSTRAINT "evaluation_runs_interview_profile_unique" UNIQUE("interview_id", "profile_id")',
    );
    expect(profileMigrationSql).toContain('CONSTRAINT "evaluation_runs_terminal_shape" CHECK');
    expect(profileMigrationSql).toContain('CONSTRAINT "evaluation_runs_timing_valid" CHECK');
    expect(profileMigrationSql).toContain("VALUES ('application', 13, now())");

    for (const preservedTable of [
      'evaluation_profiles',
      'interviews',
      'transcript_turns',
      'transcript_final_segments',
      'transcript_finalizations',
    ]) {
      expect(profileMigrationSql).not.toContain(`DROP TABLE "app"."${preservedTable}"`);
    }
  });

  it('matches the profile-scoped Drizzle foreign-key and uniqueness model', () => {
    const runConfig = getTableConfig(evaluationRuns);

    expect(
      runConfig.uniqueConstraints
        .find((constraint) => constraint.name === 'evaluation_runs_interview_profile_unique')
        ?.columns.map((column) => column.name),
    ).toEqual(['interview_id', 'profile_id']);
    expect(runConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining(['evaluation_runs_interview_fk', 'evaluation_runs_profile_fk']),
    );
    expect(runConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).not.toContain(
      'evaluation_runs_rubric_fk',
    );
  });
});
