import {
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  evaluationProfileContentSchema,
  evaluationProfileContentOf,
  evaluationProfileDocumentSchema,
  evaluationProfileDuplicateRequestSchema,
  evaluationProfileImportRequestSchema,
  evaluationProfileLockedGuardrailsSchema,
  evaluationProfilePortableOf,
  evaluationProfileSummarySchema,
  type EvaluationProfile,
  type EvaluationProfileContent,
  type EvaluationProfileDocument,
  type EvaluationProfileImportPreviewResponse,
  type EvaluationProfileLockedGuardrails,
  type EvaluationProfileSummary,
} from '@orgscience/contracts';

import type { AppUnitOfWork, RepositoryError } from '../persistence/index.js';
import { deterministicId, readClock, type Clock, type Sha256 } from '../runtime.js';

export type EvaluationProfileServiceErrorCode =
  'not_found' | 'conflict' | 'invalid_profile' | 'default_required' | 'unavailable' | 'internal';

export class EvaluationProfileServiceError extends Error {
  public constructor(
    readonly code: EvaluationProfileServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EvaluationProfileServiceError';
  }
}

export interface EvaluationProfileJsonArtifact {
  readonly body: string;
  readonly contentType: 'application/json; charset=utf-8';
  readonly fileName: string;
}

export class EvaluationProfileService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly hasher: Sha256,
    private readonly ensureDefault: () => Promise<void>,
  ) {}

  public async list(): Promise<readonly EvaluationProfileSummary[]> {
    await this.#initialize();
    const profiles = await this.unitOfWork.read(({ evaluationProfiles }) =>
      evaluationProfiles.list(),
    );
    if (!profiles.ok) throw profileRepositoryError(profiles.error);
    return profiles.value.map((profile) =>
      evaluationProfileSummarySchema.parse({
        profileId: profile.profileId,
        name: profile.name,
        description: profile.description,
        isDefault: profile.isDefault,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      }),
    );
  }

  public async get(profileId: string): Promise<EvaluationProfile> {
    await this.#initialize();
    const profile = await this.unitOfWork.read(({ evaluationProfiles }) =>
      evaluationProfiles.load(profileId),
    );
    if (!profile.ok) throw profileRepositoryError(profile.error);
    return profile.value;
  }

  public async create(contentCandidate: unknown): Promise<EvaluationProfile> {
    await this.#initialize();
    const content = parseContent(contentCandidate);
    const timestamp = nowOrThrow(this.clock);
    const profile: EvaluationProfile = {
      profileId: profileIdOrThrow(content.name, timestamp, this.hasher),
      ...content,
      isDefault: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = await this.unitOfWork.transaction(({ evaluationProfiles }) =>
      evaluationProfiles.create(profile),
    );
    if (!created.ok) throw profileRepositoryError(created.error);
    return created.value;
  }

  public async update(
    profileId: string,
    expectedUpdatedAt: string,
    contentCandidate: unknown,
  ): Promise<EvaluationProfile> {
    await this.#initialize();
    const content = parseContent(contentCandidate);
    const updated = await this.unitOfWork.transaction(async ({ evaluationProfiles }) => {
      const current = await evaluationProfiles.load(profileId);
      if (!current.ok) return current;
      const next: EvaluationProfile = {
        profileId: current.value.profileId,
        ...content,
        isDefault: current.value.isDefault,
        createdAt: current.value.createdAt,
        updatedAt: timestampAfter(expectedUpdatedAt, this.clock),
      };
      return evaluationProfiles.update(profileId, expectedUpdatedAt, next);
    });
    if (!updated.ok) throw profileRepositoryError(updated.error);
    return updated.value;
  }

  public async duplicate(profileId: string, nameCandidate: unknown): Promise<EvaluationProfile> {
    await this.#initialize();
    const parsed = evaluationProfileDuplicateRequestSchema.safeParse({ name: nameCandidate });
    if (!parsed.success) {
      throw new EvaluationProfileServiceError('invalid_profile', 'The profile name is invalid.');
    }
    const { name } = parsed.data;
    const timestamp = nowOrThrow(this.clock);
    const duplicated = await this.unitOfWork.transaction(async ({ evaluationProfiles }) => {
      const source = await evaluationProfiles.load(profileId);
      if (!source.ok) return source;
      const duplicate: EvaluationProfile = {
        ...source.value,
        profileId: profileIdOrThrow(name, timestamp, this.hasher),
        name,
        isDefault: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return evaluationProfiles.duplicate(profileId, duplicate);
    });
    if (!duplicated.ok) throw profileRepositoryError(duplicated.error);
    return duplicated.value;
  }

  public async delete(profileId: string, expectedUpdatedAt: string): Promise<EvaluationProfile> {
    await this.#initialize();
    const deleted = await this.unitOfWork.transaction(({ evaluationProfiles }) =>
      evaluationProfiles.delete(profileId, expectedUpdatedAt),
    );
    if (!deleted.ok) throw profileRepositoryError(deleted.error);
    return deleted.value;
  }

  public async exportJson(profileId: string): Promise<EvaluationProfileJsonArtifact> {
    const profile = await this.get(profileId);
    return documentArtifact(toDocument(profile));
  }

  public template(): EvaluationProfileJsonArtifact {
    return documentArtifact(genericTemplate());
  }

  public previewImport(documentCandidate: unknown): EvaluationProfileImportPreviewResponse {
    const document = parseDocument(documentCandidate);
    return { valid: true, profile: document.profile };
  }

  public async importJson(requestCandidate: unknown): Promise<EvaluationProfile> {
    await this.#initialize();
    const request = evaluationProfileImportRequestSchema.safeParse(requestCandidate);
    if (!request.success) {
      throw new EvaluationProfileServiceError('invalid_profile', 'The profile import is invalid.');
    }
    const content = contentFromDocument(request.data.document);
    if (request.data.mode === 'create') {
      const timestamp = nowOrThrow(this.clock);
      const profile: EvaluationProfile = {
        profileId: request.data.document.profile.profileId,
        ...content,
        isDefault: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const created = await this.unitOfWork.transaction(({ evaluationProfiles }) =>
        evaluationProfiles.create(profile),
      );
      if (!created.ok) throw profileRepositoryError(created.error);
      return created.value;
    }
    return this.update(request.data.targetProfileId, request.data.expectedUpdatedAt, content);
  }

  public guardrails(): EvaluationProfileLockedGuardrails {
    return evaluationProfileLockedGuardrailsSchema.parse({
      evidenceSource: 'final_participant_turns_only',
      exactQuotesRequired: true,
      validTurnReferencesRequired: true,
      fabricatedContentForbidden: true,
      hiddenChainOfThoughtForbidden: true,
      structuredOutputLocked: true,
      scoreRangeLocked: 'integer_1_7_or_non_score',
      aggregationLocked: true,
    });
  }

  async #initialize(): Promise<void> {
    try {
      await this.ensureDefault();
    } catch {
      throw new EvaluationProfileServiceError(
        'unavailable',
        'Evaluation profiles are temporarily unavailable.',
        true,
      );
    }
  }
}

function parseContent(candidate: unknown): EvaluationProfileContent {
  const parsed = evaluationProfileContentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new EvaluationProfileServiceError('invalid_profile', 'The profile is invalid.');
  }
  return parsed.data;
}

function parseDocument(candidate: unknown): EvaluationProfileDocument {
  const parsed = evaluationProfileDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new EvaluationProfileServiceError('invalid_profile', 'The profile document is invalid.');
  }
  return parsed.data;
}

function contentFromDocument(document: EvaluationProfileDocument): EvaluationProfileContent {
  return evaluationProfileContentSchema.parse(evaluationProfileContentOf(document.profile));
}

function toDocument(profile: EvaluationProfile): EvaluationProfileDocument {
  return evaluationProfileDocumentSchema.parse({
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: evaluationProfilePortableOf(profile),
  });
}

function genericTemplate(): EvaluationProfileDocument {
  return evaluationProfileDocumentSchema.parse({
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: {
      profileId: 'profile-template',
      name: 'New evaluation profile',
      description: 'Describe the construct evaluated by this profile.',
      coderPrompt: 'Assess every item using only the available interview evidence.',
      scale: { minimum: 1, maximum: 7 },
      calculation: { mode: 'weighted_mean' },
      dimensions: [{ dimensionId: 'dimension-1', name: 'Dimension 1', order: 0, weight: 1 }],
      items: [
        {
          itemId: 'item-1',
          dimensionId: 'dimension-1',
          name: 'Item 1',
          codingInstruction: 'Describe the observable evidence required for this item.',
          order: 0,
          weight: 1,
          anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
            score,
            criterion: `Define the observable criterion for score ${String(score)}.`,
          })),
        },
      ],
    },
  });
}

function documentArtifact(document: EvaluationProfileDocument): EvaluationProfileJsonArtifact {
  return {
    body: `${JSON.stringify(document, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    fileName: `${document.profile.profileId}.evaluation-profile.json`,
  };
}

function profileIdOrThrow(name: string, timestamp: string, hasher: Sha256): string {
  const generated = deterministicId('profile', `${name}:${timestamp}`, hasher);
  if (!generated.ok) {
    throw new EvaluationProfileServiceError('internal', 'Profile ID creation failed.');
  }
  return generated.value;
}

function nowOrThrow(clock: Clock): string {
  const timestamp = readClock(clock);
  if (!timestamp.ok) {
    throw new EvaluationProfileServiceError('internal', 'Profile clock is invalid.');
  }
  return timestamp.value;
}

function timestampAfter(expectedUpdatedAt: string, clock: Clock): string {
  const timestamp = nowOrThrow(clock);
  const expected = Date.parse(expectedUpdatedAt);
  if (!Number.isFinite(expected)) {
    throw new EvaluationProfileServiceError('invalid_profile', 'The update token is invalid.');
  }
  return Date.parse(timestamp) > expected ? timestamp : new Date(expected + 1).toISOString();
}

function profileRepositoryError(error: RepositoryError): EvaluationProfileServiceError {
  switch (error.code) {
    case 'not_found':
      return new EvaluationProfileServiceError(
        'not_found',
        'The evaluation profile was not found.',
      );
    case 'duplicate_conflict':
    case 'stale_version':
    case 'sequence_conflict':
    case 'active_job_exists':
    case 'lease_lost':
    case 'interview_busy':
      return new EvaluationProfileServiceError(
        'conflict',
        'The profile ID, name, or update token conflicts with existing data.',
      );
    case 'constraint_violation':
      return error.constraint === 'evaluation_profiles_default_required'
        ? new EvaluationProfileServiceError(
            'default_required',
            'The default evaluation profile cannot be deleted.',
          )
        : new EvaluationProfileServiceError('invalid_profile', 'The profile is invalid.');
    case 'serialization_failure':
    case 'unavailable':
      return new EvaluationProfileServiceError(
        'unavailable',
        'Evaluation profiles are temporarily unavailable.',
        true,
      );
    case 'transcript_finalized':
    case 'pending_ai_delivery':
    case 'unresolved_transcript_partial':
    case 'corrupt_data':
    case 'internal':
      return new EvaluationProfileServiceError(
        'internal',
        'Evaluation profile persistence failed.',
      );
  }
}
