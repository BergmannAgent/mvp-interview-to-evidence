import type { AppReadContext, AppTransaction } from '../../application/persistence/index.js';
import { PostgresConsistencyRepository } from './repositories/consistency-repository.js';
import { PostgresEvaluationRepository } from './repositories/evaluation-repository.js';
import { PostgresEvaluationProfileRepository } from './repositories/evaluation-profile-repository.js';
import { PostgresFinalizationRepository } from './repositories/finalization-repository.js';
import { PostgresGuideRepository } from './repositories/guide-repository.js';
import { PostgresInterviewRepository } from './repositories/interview-repository.js';
import { PostgresInterviewSettingsRepository } from './repositories/interview-settings-repository.js';
import { PostgreSqlJobRepository } from './repositories/job-repository.js';
import { PostgresOutboxRepository } from './repositories/outbox-repository.js';
import { PostgresRunRepository } from './repositories/run-repository.js';
import type { SqlExecutor } from './repositories/sql.js';
import { PostgresTranscriptRepository } from './repositories/transcript-repository.js';
import type { PersistenceContextFactory } from './unit-of-work.js';

export class PostgresPersistenceContextFactory implements PersistenceContextFactory {
  public createReadContext(executor: SqlExecutor): AppReadContext {
    return createContext(executor);
  }

  public createTransaction(executor: SqlExecutor): AppTransaction {
    return createContext(executor);
  }
}

function createContext(executor: SqlExecutor): AppTransaction {
  return {
    interviewSettings: new PostgresInterviewSettingsRepository(executor),
    guides: new PostgresGuideRepository(executor),
    interviews: new PostgresInterviewRepository(executor),
    transcripts: new PostgresTranscriptRepository(executor),
    outbox: new PostgresOutboxRepository(executor),
    jobs: new PostgreSqlJobRepository(executor),
    runs: new PostgresRunRepository(executor),
    finalizations: new PostgresFinalizationRepository(executor),
    consistency: new PostgresConsistencyRepository(executor),
    evaluations: new PostgresEvaluationRepository(executor),
    evaluationProfiles: new PostgresEvaluationProfileRepository(executor),
  };
}
