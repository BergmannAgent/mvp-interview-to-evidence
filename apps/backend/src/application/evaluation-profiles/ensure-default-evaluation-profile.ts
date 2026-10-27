import type { EvaluationProfile } from '@orgscience/contracts';

import type { OrganizationalResilienceEvaluationAssets } from '../evaluations/organizational-resilience-rubric.js';
import type { AppUnitOfWork, RepositoryError } from '../persistence/index.js';
import { readClock, type Clock } from '../runtime.js';
import { buildDefaultEvaluationProfile } from './default-evaluation-profile.js';

export class EvaluationProfileSeedError extends Error {
  public constructor(readonly retryable: boolean) {
    super('The default evaluation profile could not be initialized.');
    this.name = 'EvaluationProfileSeedError';
  }
}

export class EnsureDefaultEvaluationProfileService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly assets: OrganizationalResilienceEvaluationAssets,
  ) {}

  public async execute(): Promise<EvaluationProfile> {
    const timestamp = readClock(this.clock);
    if (!timestamp.ok) throw new EvaluationProfileSeedError(false);
    const profile = buildDefaultEvaluationProfile(this.assets, timestamp.value);
    const seeded = await this.unitOfWork.transaction(({ evaluationProfiles }) =>
      evaluationProfiles.seedDefault(profile),
    );
    if (!seeded.ok) throw seedError(seeded.error);
    return seeded.value.value;
  }
}

function seedError(error: RepositoryError): EvaluationProfileSeedError {
  return new EvaluationProfileSeedError(
    error.code === 'unavailable' ||
      error.code === 'serialization_failure' ||
      error.code === 'duplicate_conflict',
  );
}
