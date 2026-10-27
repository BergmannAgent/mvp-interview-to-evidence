import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  evaluationProfileSchema,
  evaluationProfilePortableOf,
  type EvaluationProfile,
  type SupportedLocale,
} from '@orgscience/contracts';
import {
  initializeGuideCoverage,
  parseInterviewGuideMarkdown,
  type InterviewGuideSnapshot,
  type InterviewLifecycleState,
  type TranscriptAggregate,
} from '@orgscience/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type EvaluationRunCompletion,
  type EvaluationRunFailure,
  type EvaluationRunRestart,
  type EvaluationRunStart,
  type PersistedInterview,
  type RepositoryResult,
  type StoredEvaluationRun,
  type StoredFinalization,
} from '../persistence/index.js';
import { DemoEvaluationCoder } from './demo-evaluation-coder.js';
import type { EvaluationCoder, EvaluationCodingResult } from './evaluation-coder.js';
import { EvaluationService } from './evaluation-service.js';

const T0 = '2026-08-21T10:00:00.000Z';
const T1 = '2026-08-21T10:01:00.000Z';
const T2 = '2026-08-21T10:02:00.000Z';
const T3 = '2026-08-21T10:03:00.000Z';
const T4 = '2026-08-21T10:04:00.000Z';
const T5 = '2026-08-21T10:05:00.000Z';
const T6 = '2026-08-21T10:06:00.000Z';
const hasher = {
  digestUtf8: (value: string): string => createHash('sha256').update(value).digest('hex'),
};

describe('profile-driven EvaluationService', () => {
  it('retains the exact v1 profile fingerprint for implicit and explicit default calculation settings', async () => {
    const profiles = profileStore();
    const selected = profiles.get('profile-alternate')!;
    const service = createService(
      new MemoryEvaluationStore(),
      new CountingCoder(),
      [T4, T5],
      profiles,
    );
    const first = await service.run('interview-a', selected.profileId);
    expect(first.status).toBe('completed');
    const oldDocument = { schemaVersion: 1, profile: evaluationProfilePortableOf(selected) };
    const expected = createHash('sha256').update(canonicalJson(oldDocument)).digest('hex');
    expect(first.profileFingerprint).toBe(expected);
    profiles.set(
      selected.profileId,
      evaluationProfileSchema.parse({
        ...selected,
        calculation: { mode: 'weighted_mean' },
        dimensions: selected.dimensions.map((dimension) => ({ ...dimension, weight: 1 })),
        items: selected.items.map((item) => ({ ...item, weight: 1 })),
      }),
    );
    const cached = await service.get('interview-a', selected.profileId);
    expect(cached.status).toBe('completed');
    expect(cached.profileFingerprint).toBe(expected);
  });

  it.each(['item_weight', 'dimension_weight', 'formula'] as const)(
    'invalidates %s edits while keeping all calculation configuration out of coder inputs',
    async (change) => {
      const profiles = profileStore();
      const original = profiles.get('profile-alternate')!;
      const seen: Parameters<EvaluationCoder['code']>[0][] = [];
      const delegate = new DemoEvaluationCoder();
      const coder: EvaluationCoder = {
        model: delegate.model,
        async code(input, context) {
          seen.push(structuredClone(input));
          return delegate.code(input, context);
        },
      };
      const service = createService(
        new MemoryEvaluationStore(),
        coder,
        [T4, T5, T6, '2026-08-21T10:07:00.000Z'],
        profiles,
      );
      const first = await service.run('interview-a', original.profileId);
      const changed = structuredClone(original);
      if (change === 'item_weight') changed.items[0]!.weight = 2;
      if (change === 'dimension_weight') changed.dimensions[0]!.weight = 0.5;
      if (change === 'formula')
        changed.calculation = { mode: 'formula', expression: 'item("practice-1") * 2' };
      profiles.set(original.profileId, evaluationProfileSchema.parse(changed));
      expect((await service.get('interview-a', original.profileId)).status).toBe('not_started');
      const second = await service.run('interview-a', original.profileId);
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      if (first.status !== 'completed' || second.status !== 'completed') return;
      expect(second.profileFingerprint).not.toBe(first.profileFingerprint);
      expect(second.report.dimensions[0]!.items[0]!.score).toBe(
        first.report.dimensions[0]!.items[0]!.score,
      );
      expect(second.report.profile).toMatchObject(evaluationProfilePortableOf(changed));
      expect(seen).toHaveLength(2);
      expect(seen[1]!.profile).toEqual(seen[0]!.profile);
      expect(seen[1]!.profile.schemaVersion).toBe(1);
      expect(seen[1]!.profile.profile).not.toHaveProperty('calculation');
      expect(seen[1]!.profile.profile.dimensions[0]).not.toHaveProperty('weight');
      expect(seen[1]!.profile.profile.items[0]).not.toHaveProperty('weight');
      if (change === 'formula')
        expect(second.report.overallAggregate.score).toBe(first.report.overallAggregate.score! * 2);
    },
  );

  it('keeps reads side-effect free and uses the default profile when none is selected', async () => {
    const store = new MemoryEvaluationStore();
    const coder = new CountingCoder();
    const service = createService(store, coder, [T4, T5]);

    const before = await service.get('interview-a');
    expect(before).toMatchObject({
      status: 'not_started',
      interviewId: 'interview-a',
      profileId: 'profile-default',
    });
    expect(coder.calls).toBe(0);

    const completed = await service.run('interview-a');
    expect(completed).toMatchObject({
      status: 'completed',
      profileId: 'profile-default',
      report: {
        reportKind: 'evaluation_profile_report',
        profileName: 'default',
        promptVersion: 'profile-evidence-coding-v7',
      },
    });
    expect(coder.calls).toBe(1);
    await expect(service.get('interview-a')).resolves.toEqual(completed);
  });

  it.each([
    { label: 'active', lifecycleStatus: 'active' as const, finalized: false },
    {
      label: 'completed but not finalized',
      lifecycleStatus: 'completed' as const,
      finalized: false,
    },
  ])('keeps the persisted English locale for a $label interview', async (variant) => {
    const store = new MemoryEvaluationStore();
    const englishSource = source('interview-en', 'examples/organizational-resilience.en.md', {
      language: 'en',
      lifecycleStatus: variant.lifecycleStatus,
      finalized: variant.finalized,
    });
    const service = createService(
      store,
      new CountingCoder(),
      [],
      profileStore(),
      new Map([['interview-en', englishSource]]),
    );

    await expect(service.get('interview-en')).resolves.toMatchObject({
      status: 'not_started',
      interviewId: 'interview-en',
      language: 'en',
    });
  });

  it('evaluates one interview with independent profiles and one profile across guides', async () => {
    const store = new MemoryEvaluationStore();
    const coder = new CountingCoder();
    const service = createService(store, coder, [T4, T5, T4, T5, T4, T5]);

    const defaultRun = await service.run('interview-a');
    const alternateRun = await service.run('interview-a', 'profile-alternate');
    const otherGuideRun = await service.run('interview-b', 'profile-alternate');

    expect(defaultRun.profileId).toBe('profile-default');
    expect(alternateRun.profileId).toBe('profile-alternate');
    expect(otherGuideRun.profileId).toBe('profile-alternate');
    expect(store.runs).toHaveLength(3);
    expect(coder.calls).toBe(3);
    if (alternateRun.status !== 'completed' || otherGuideRun.status !== 'completed') return;
    expect(alternateRun.report.profile).toEqual(otherGuideRun.report.profile);
    expect('guideId' in alternateRun.report).toBe(false);
  });

  it('replaces the current interview/profile result on explicit rerun with a stable ID', async () => {
    const store = new MemoryEvaluationStore();
    const coder = new CountingCoder();
    const service = createService(store, coder, [T4, T5, T6, '2026-08-21T10:07:00.000Z']);

    const first = await service.run('interview-a', 'profile-alternate');
    const second = await service.retry('interview-a', 'profile-alternate');

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.startedAt).not.toBe(first.startedAt);
    expect(store.runs).toHaveLength(1);
    expect(store.restarts).toBe(1);
    expect(coder.calls).toBe(2);
  });

  it('persists a provider failure and remains explicitly retryable', async () => {
    const store = new MemoryEvaluationStore();
    const coder = new FailOnceCoder();
    const service = createService(store, coder, [T4, T5, T6, '2026-08-21T10:07:00.000Z']);

    const failed = await service.run('interview-a');
    expect(failed).toMatchObject({ status: 'failed', failure: { retryable: true } });

    const completed = await service.retry('interview-a');
    expect(completed.status).toBe('completed');
    expect(coder.calls).toBe(2);
  });

  it('invalidates a persisted result after profile content changes', async () => {
    const store = new MemoryEvaluationStore();
    const profiles = profileStore();
    const coder = new CountingCoder();
    const service = createService(store, coder, [T4, T5, T6, '2026-08-21T10:07:00.000Z'], profiles);

    const first = await service.run('interview-a', 'profile-alternate');
    profiles.set(
      'profile-alternate',
      evaluationProfileSchema.parse({
        ...profiles.get('profile-alternate'),
        coderPrompt: 'Changed domain instructions.',
        updatedAt: T6,
      }),
    );

    const staleRead = await service.get('interview-a', 'profile-alternate');
    expect(staleRead.status).toBe('not_started');
    const replaced = await service.run('interview-a', 'profile-alternate');
    expect(replaced.status).toBe('completed');
    if (first.status !== 'completed' || replaced.status !== 'completed') return;
    expect(replaced.profileFingerprint).not.toBe(first.profileFingerprint);
    expect(replaced.report.profile.coderPrompt).toBe('Changed domain instructions.');
  });

  it.each(['active', 'paused', 'ending', 'failed', 'completed'] as const)(
    'evaluates confirmed turns of an unfinished %s interview without ending or finalizing it',
    async (lifecycleStatus) => {
      const original = source(
        'interview-incomplete',
        'guides/fixtures/interviewleitfaden-demo.md',
        {
          lifecycleStatus,
          finalized: false,
        },
      );
      const before = structuredClone(original);
      const sources = new Map([['interview-incomplete', original]]);
      const coder = new CountingCoder();
      const service = createService(
        new MemoryEvaluationStore(),
        coder,
        [T4, T5],
        profileStore(),
        sources,
      );
      const completed = await service.run('interview-incomplete');
      expect(completed.status).toBe('completed');
      expect(coder.calls).toBe(1);
      expect(sources.get('interview-incomplete')).toEqual(before);
      await expect(service.get('interview-incomplete')).resolves.toEqual(completed);
      const exported = await service.export('interview-incomplete', 'json');
      expect(JSON.parse(exported.body)).toMatchObject({
        sourceTranscript: {
          interviewStatus:
            lifecycleStatus === 'failed'
              ? 'completed'
              : lifecycleStatus === 'ending'
                ? 'active'
                : lifecycleStatus,
          finalized: false,
          turnCount: 2,
          ignoredPartial: false,
        },
      });
    },
  );

  it('retains the historical finalized fingerprint for existing completed results', async () => {
    const service = createService(new MemoryEvaluationStore(), new CountingCoder(), [T4, T5]);
    const result = await service.run('interview-a');
    if (result.status !== 'completed') throw new Error('Expected a completed evaluation');
    expect(result.report.transcriptFingerprint).toBe(
      createHash('sha256').update('interview-a').digest('hex'),
    );
    expect(result.report.sourceTranscript?.finalized).toBe(true);
  });

  it('excludes live partial text from the evaluation snapshot without deleting it from stored state', async () => {
    const initial = source('interview-partial', 'guides/fixtures/interviewleitfaden-demo.md', {
      lifecycleStatus: 'active',
      finalized: false,
    });
    const original: EvaluationTestSource = {
      ...initial,
      transcript: {
        ...initial.transcript,
        partials: [
          {
            interviewId: 'interview-partial',
            sourceProvider: 'openai_realtime',
            utteranceId: 'partial-utterance',
            providerEventId: 'partial-event',
            segmentId: 'partial-segment',
            text: 'UNCONFIRMED SHOULD NEVER BE SCORED',
            revision: 1,
            observedAt: T3,
          },
        ],
      },
    };
    const sources = new Map([['interview-partial', original]]);
    const seen: Parameters<EvaluationCoder['code']>[0][] = [];
    const delegate = new DemoEvaluationCoder();
    const coder: EvaluationCoder = {
      model: delegate.model,
      async code(input, context) {
        seen.push(input);
        return delegate.code(input, context);
      },
    };
    const service = createService(
      new MemoryEvaluationStore(),
      coder,
      [T4, T5],
      profileStore(),
      sources,
    );
    const result = await service.run('interview-partial');
    expect(result.status).toBe('completed');
    expect(seen[0]?.session.partialTranscript).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('UNCONFIRMED SHOULD NEVER BE SCORED');
    expect(original.transcript.partials[0]?.text).toBe('UNCONFIRMED SHOULD NEVER BE SCORED');
    if (result.status === 'completed')
      expect(result.report.sourceTranscript).toMatchObject({
        finalized: false,
        ignoredPartial: true,
      });
    sources.set('interview-partial', {
      ...original,
      interview: { ...original.interview, updatedAt: T6 },
      transcript: {
        ...original.transcript,
        partials: original.transcript.partials.map((partial) => ({
          ...partial,
          text: 'Changed partial',
          revision: 2,
          observedAt: T6,
        })),
      },
    });
    await expect(service.get('interview-partial')).resolves.toEqual(result);
  });

  it('invalidates an incomplete result when confirmed turns change and permits a fresh rerun', async () => {
    const initial = source('interview-growing', 'guides/fixtures/interviewleitfaden-demo.md', {
      lifecycleStatus: 'active',
      finalized: false,
    });
    const sources = new Map([['interview-growing', initial]]);
    const coder = new CountingCoder();
    const service = createService(
      new MemoryEvaluationStore(),
      coder,
      [T4, T5, T6, '2026-08-21T10:07:00.000Z'],
      profileStore(),
      sources,
    );
    const first = await service.run('interview-growing');
    sources.set('interview-growing', withAnotherAnswer(initial));
    await expect(service.get('interview-growing')).resolves.toMatchObject({
      status: 'not_started',
    });
    await expect(service.export('interview-growing', 'markdown')).rejects.toMatchObject({
      code: 'invalid_state',
    });
    const second = await service.run('interview-growing');
    expect(coder.calls).toBe(2);
    if (first.status !== 'completed' || second.status !== 'completed')
      throw new Error('Expected both completed evaluations');
    expect(second.report.transcriptFingerprint).not.toBe(first.report.transcriptFingerprint);
    expect(second.report.sourceTranscript?.turnCount).toBe(3);
  });

  it('keeps an in-flight evaluation tied to its frozen turns if the interview continues', async () => {
    const initial = source('interview-concurrent', 'guides/fixtures/interviewleitfaden-demo.md', {
      lifecycleStatus: 'active',
      finalized: false,
    });
    const sources = new Map([['interview-concurrent', initial]]);
    let release: () => void = () => {
      throw new Error('Barrier is not initialized');
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Parameters<EvaluationCoder['code']>[0][] = [];
    const delegate = new DemoEvaluationCoder();
    const coder: EvaluationCoder = {
      model: delegate.model,
      async code(input, context) {
        seen.push(input);
        await barrier;
        return delegate.code(input, context);
      },
    };
    const service = createService(
      new MemoryEvaluationStore(),
      coder,
      [T4, T5],
      profileStore(),
      sources,
    );
    const pending = service.run('interview-concurrent');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    sources.set('interview-concurrent', withAnotherAnswer(initial));
    await expect(service.run('interview-concurrent')).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    });
    release();
    const result = await pending;
    expect(result.status).toBe('completed');
    expect(seen[0]?.session.transcript).toHaveLength(2);
    if (result.status === 'completed') expect(result.report.sourceTranscript?.turnCount).toBe(2);
    await expect(service.get('interview-concurrent')).resolves.toMatchObject({
      status: 'not_started',
    });
  });

  it('invalidates an incomplete evaluation when a canonical technical gap is added', async () => {
    const initial = source('interview-gap', 'guides/fixtures/interviewleitfaden-demo.md', {
      lifecycleStatus: 'active',
      finalized: false,
    });
    const sources = new Map([['interview-gap', initial]]);
    const service = createService(
      new MemoryEvaluationStore(),
      new CountingCoder(),
      [T4, T5],
      profileStore(),
      sources,
    );
    expect((await service.run('interview-gap')).status).toBe('completed');
    sources.set('interview-gap', {
      ...initial,
      transcript: {
        ...initial.transcript,
        nextSequenceNumber: 4,
        entries: [
          ...initial.transcript.entries,
          {
            kind: 'technical_gap',
            interviewId: 'interview-gap',
            gapId: 'transport-gap',
            sourceEventId: 'gap-event',
            sequenceNumber: 3,
            occurredAt: T4,
            source: 'transport',
            sourceProvider: null,
            relatedUtteranceId: null,
            relatedSegmentId: null,
            description: 'An output segment was not confirmed.',
          },
        ],
      },
    });
    await expect(service.get('interview-gap')).resolves.toMatchObject({ status: 'not_started' });
  });

  it('rejects ready interviews and interviews without a confirmed participant answer', async () => {
    for (const lifecycleStatus of ['ready', 'active'] as const) {
      const initial = source('interview-empty', 'guides/fixtures/interviewleitfaden-demo.md', {
        lifecycleStatus,
        finalized: false,
      });
      const noAnswer = {
        ...initial,
        transcript: {
          ...initial.transcript,
          entries: initial.transcript.entries.slice(0, 1),
          nextSequenceNumber: 2,
        },
      };
      const coder = new CountingCoder();
      const service = createService(
        new MemoryEvaluationStore(),
        coder,
        [],
        profileStore(),
        new Map([['interview-empty', noAnswer]]),
      );
      await expect(service.run('interview-empty')).rejects.toMatchObject({ code: 'invalid_state' });
      expect(coder.calls).toBe(0);
    }
  });
});

function withAnotherAnswer(initial: EvaluationTestSource): EvaluationTestSource {
  const answer = initial.transcript.entries[1];
  if (answer?.kind !== 'turn' || answer.speaker !== 'participant')
    throw new Error('Expected participant fixture');
  return {
    ...initial,
    transcript: {
      ...initial.transcript,
      nextSequenceNumber: 4,
      entries: [
        ...initial.transcript.entries,
        {
          ...answer,
          sequenceNumber: 3,
          turnId: `${initial.interview.interviewId}-participant-2`,
          providerEventId: 'provider-second-final',
          sourceSegmentId: 'segment-second-final',
          text: 'The team also recorded the remaining operational gaps.',
          occurredAt: T4,
        },
      ],
    },
  };
}

class CountingCoder implements EvaluationCoder {
  readonly model = { mode: 'demo', provider: null, model: null } as const;
  readonly #delegate = new DemoEvaluationCoder();
  calls = 0;

  async code(
    input: Parameters<EvaluationCoder['code']>[0],
    context: Parameters<EvaluationCoder['code']>[1],
  ): Promise<EvaluationCodingResult> {
    this.calls += 1;
    return this.#delegate.code(input, context);
  }
}

class FailOnceCoder extends CountingCoder {
  override async code(
    input: Parameters<EvaluationCoder['code']>[0],
    context: Parameters<EvaluationCoder['code']>[1],
  ): Promise<EvaluationCodingResult> {
    if (this.calls === 0) {
      this.calls += 1;
      return {
        ok: false,
        error: { code: 'provider_error', message: 'Provider failed.', retryable: true },
      };
    }
    return super.code(input, context);
  }
}

class QueueClock {
  constructor(private readonly values: string[]) {}

  now(): string {
    const value = this.values.shift();
    if (value === undefined) throw new Error('Unexpected clock read');
    return value;
  }
}

class MemoryEvaluationStore {
  readonly runs: StoredEvaluationRun[] = [];
  restarts = 0;

  async loadRun(interviewId: string, evaluationId: string) {
    const run = this.runs.find(
      (candidate) =>
        candidate.interviewId === interviewId && candidate.evaluationId === evaluationId,
    );
    return run === undefined
      ? failure({
          code: 'not_found' as const,
          resource: 'evaluation_run' as const,
          id: evaluationId,
        })
      : success(run);
  }

  async findRunByProfile(input: { readonly interviewId: string; readonly profileId: string }) {
    return success(
      this.runs.find(
        (run) => run.interviewId === input.interviewId && run.profileId === input.profileId,
      ) ?? null,
    );
  }

  async startRun(_interviewId: string, start: EvaluationRunStart) {
    const existing = this.runs.find(
      (run) => run.interviewId === start.interviewId && run.profileId === start.profileId,
    );
    if (existing !== undefined) return success({ outcome: 'existing' as const, value: existing });
    const run: StoredEvaluationRun = {
      ...start,
      status: 'running',
      endedAt: null,
      durationMs: null,
      report: null,
      failure: null,
    };
    this.runs.push(run);
    return success({ outcome: 'inserted' as const, value: run });
  }

  async completeRun(
    interviewId: string,
    evaluationId: string,
    completion: EvaluationRunCompletion,
  ) {
    const index = this.runIndex(interviewId, evaluationId);
    const current = this.runs[index]!;
    if (current.status !== 'running' || current.startedAt !== completion.attemptStartedAt) {
      return conflict(evaluationId);
    }
    const completed: StoredEvaluationRun = {
      ...current,
      status: 'completed',
      endedAt: completion.completedAt,
      durationMs: completion.durationMs,
      report: completion.report,
      failure: null,
    };
    this.runs[index] = completed;
    return success({ outcome: 'updated' as const, value: completed });
  }

  async failRun(interviewId: string, evaluationId: string, failed: EvaluationRunFailure) {
    const index = this.runIndex(interviewId, evaluationId);
    const current = this.runs[index]!;
    if (current.status !== 'running' || current.startedAt !== failed.attemptStartedAt) {
      return conflict(evaluationId);
    }
    const terminal: StoredEvaluationRun = {
      ...current,
      status: 'failed',
      endedAt: failed.failedAt,
      durationMs: failed.durationMs,
      report: null,
      failure: failed.failure,
    };
    this.runs[index] = terminal;
    return success({ outcome: 'updated' as const, value: terminal });
  }

  async restartRun(interviewId: string, evaluationId: string, restart: EvaluationRunRestart) {
    const index = this.runIndex(interviewId, evaluationId);
    const current = this.runs[index]!;
    if (current.startedAt !== restart.expectedStartedAt) return conflict(evaluationId);
    const running: StoredEvaluationRun = {
      ...current,
      status: 'running',
      profileFingerprint: restart.profileFingerprint,
      transcriptFingerprint: restart.transcriptFingerprint,
      promptVersion: restart.promptVersion,
      model: restart.model,
      startedAt: restart.startedAt,
      endedAt: null,
      durationMs: null,
      report: null,
      failure: null,
    };
    this.runs[index] = running;
    this.restarts += 1;
    return success({ outcome: 'updated' as const, value: running });
  }

  private runIndex(interviewId: string, evaluationId: string): number {
    const index = this.runs.findIndex(
      (run) => run.interviewId === interviewId && run.evaluationId === evaluationId,
    );
    if (index < 0) throw new Error('Expected evaluation run');
    return index;
  }
}

class EvaluationUnitOfWork implements AppUnitOfWork {
  constructor(
    private readonly readContext: AppReadContext,
    private readonly transactionContext: AppTransaction,
  ) {}

  read<T>(operation: (context: AppReadContext) => Promise<RepositoryResult<T>>) {
    return operation(this.readContext);
  }

  transaction<T>(operation: (context: AppTransaction) => Promise<RepositoryResult<T>>) {
    return operation(this.transactionContext);
  }
}

function createService(
  evaluations: MemoryEvaluationStore,
  coder: EvaluationCoder,
  clockValues: string[],
  profiles = profileStore(),
  sources: Map<string, EvaluationTestSource> = defaultSources(),
): EvaluationService {
  const contexts = {
    guides: {
      getById: async (guideId: string) => {
        const match = [...sources.values()].find((candidate) => candidate.guide.id === guideId);
        return match === undefined
          ? failure({ code: 'not_found' as const, resource: 'guide' as const, id: guideId })
          : success(match.guide);
      },
    },
    interviews: {
      lock: async (interviewId: string) => {
        const match = sources.get(interviewId);
        return match === undefined
          ? failure({ code: 'not_found' as const, resource: 'interview' as const, id: interviewId })
          : success(match.interview);
      },
      load: async (interviewId: string) => {
        const match = sources.get(interviewId);
        return match === undefined
          ? failure({ code: 'not_found' as const, resource: 'interview' as const, id: interviewId })
          : success(match.interview);
      },
    },
    transcripts: {
      loadAggregate: async (interviewId: string) => {
        const match = sources.get(interviewId);
        return match === undefined
          ? failure({
              code: 'not_found' as const,
              resource: 'transcript' as const,
              id: interviewId,
            })
          : success(match.transcript);
      },
    },
    finalizations: {
      loadLatest: async (interviewId: string) => {
        const match = sources.get(interviewId);
        return match === undefined
          ? failure({
              code: 'not_found' as const,
              resource: 'transcript_finalization' as const,
              id: interviewId,
            })
          : success(match.finalization);
      },
    },
    evaluationProfiles: {
      load: async (profileId: string) => {
        const profile = profiles.get(profileId);
        return profile === undefined
          ? failure({
              code: 'not_found' as const,
              resource: 'evaluation_profile' as const,
              id: profileId,
            })
          : success(profile);
      },
      loadDefault: async () => success(profiles.get('profile-default')!),
    },
    evaluations,
  };
  return new EvaluationService(
    new EvaluationUnitOfWork(
      contexts as unknown as AppReadContext,
      contexts as unknown as AppTransaction,
    ),
    new QueueClock(clockValues),
    hasher,
    coder,
  );
}

function defaultSources(): Map<string, EvaluationTestSource> {
  return new Map([
    ['interview-a', source('interview-a', 'guides/fixtures/interviewleitfaden-demo.md')],
    [
      'interview-b',
      source('interview-b', 'guides/interviewleitfaden-organizational-resilience-9-items.md'),
    ],
  ]);
}

interface EvaluationTestSource {
  readonly guide: InterviewGuideSnapshot;
  readonly interview: PersistedInterview;
  readonly transcript: TranscriptAggregate;
  readonly finalization: StoredFinalization | null;
}

interface EvaluationTestSourceOptions {
  readonly language?: SupportedLocale;
  readonly lifecycleStatus?: 'ready' | 'active' | 'paused' | 'ending' | 'failed' | 'completed';
  readonly finalized?: boolean;
}

function source(
  interviewId: string,
  fileName: string,
  options: EvaluationTestSourceOptions = {},
): EvaluationTestSource {
  const sourceMarkdown = readFileSync(fileName, 'utf8');
  const parsed = parseInterviewGuideMarkdown(sourceMarkdown, options.language ?? 'de');
  if (!parsed.success) throw new Error(`Expected ${fileName} to parse`);
  const guide: InterviewGuideSnapshot = { ...parsed.guide, sourceMarkdown, createdAt: T0 };
  const section = guide.sections[0]!;
  const question = section.mainQuestions[0]!;
  const reference = {
    kind: 'main_question' as const,
    guideId: guide.id,
    sectionId: section.id,
    mainQuestionId: question.id,
  };
  const transcript: TranscriptAggregate = {
    interviewId,
    guideId: guide.id,
    guideQuestionIndex: [reference],
    nextSequenceNumber: 3,
    entries: [
      {
        kind: 'turn',
        interviewId,
        sequenceNumber: 1,
        turnId: `${interviewId}-ai-1`,
        deliveryEventId: `${interviewId}-delivery-1`,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: question.text,
        occurredAt: T1,
        guideReference: reference,
        delivery: { status: 'complete' },
      },
      {
        kind: 'turn',
        interviewId,
        sequenceNumber: 2,
        turnId: `${interviewId}-participant-1`,
        sourceProvider: 'openai-realtime',
        providerEventId: `${interviewId}-provider-final-1`,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'We use documented responsibilities and review the process regularly.',
        occurredAt: T2,
        guideReference: reference,
        sourceSegmentId: `${interviewId}-segment-1`,
      },
    ],
    partials: [],
    finals: [],
  };
  const lifecycle: InterviewLifecycleState =
    options.lifecycleStatus === 'ready'
      ? { status: 'ready', interviewId, guideId: guide.id, createdAt: T0, revision: 2 }
      : options.lifecycleStatus === 'paused'
        ? {
            status: 'paused',
            interviewId,
            guideId: guide.id,
            createdAt: T0,
            revision: 2,
            startedAt: T0,
            pausedAt: T3,
          }
        : options.lifecycleStatus === 'ending'
          ? {
              status: 'ending',
              interviewId,
              guideId: guide.id,
              createdAt: T0,
              revision: 2,
              startedAt: T0,
              endingAt: T3,
              endingFrom: 'active',
            }
          : options.lifecycleStatus === 'failed'
            ? {
                status: 'failed',
                interviewId,
                guideId: guide.id,
                createdAt: T0,
                revision: 2,
                startedAt: T0,
                failedAt: T3,
                failedFrom: 'active',
                failure: { code: 'transport', message: 'Connection lost' },
              }
            : options.lifecycleStatus === 'active'
              ? {
                  status: 'active',
                  interviewId,
                  guideId: guide.id,
                  createdAt: T0,
                  revision: 2,
                  startedAt: T0,
                  activeSince: T1,
                }
              : {
                  status: 'completed',
                  interviewId,
                  guideId: guide.id,
                  createdAt: T0,
                  revision: 2,
                  startedAt: T0,
                  endingAt: T2,
                  endedAt: T3,
                };
  const interview: PersistedInterview = {
    interviewId,
    guideId: guide.id,
    language: options.language ?? guide.sourceLanguage,
    lifecycle,
    coverage: initializeGuideCoverage(guide, interviewId),
    version: 2,
    activeWorkflowRunId: null,
    createdAt: T0,
    updatedAt: T3,
  };
  const finalization: StoredFinalization | null =
    options.finalized === false
      ? null
      : {
          interviewId,
          finalizationId: `${interviewId}-finalization`,
          stateVersion: 2,
          agentRunId: `${interviewId}-agent-finalization`,
          finalizedAt: T3,
          deterministicValidation: { valid: true, issues: [] },
          agentReport: {
            status: 'valid',
            checkedCanonicalEntries: [
              { entryId: `${interviewId}-ai-1`, kind: 'turn' },
              { entryId: `${interviewId}-participant-1`, kind: 'turn' },
            ],
            checks: {
              chronologyValid: true,
              sequenceValid: true,
              speakerAssignmentsValid: true,
              noDuplicateTurns: true,
            },
            issues: [],
            rationale: 'The canonical transcript is complete.',
          },
          transcriptFingerprint: createHash('sha256').update(interviewId).digest('hex'),
          entryCount: 2,
          technicalGapCount: 0,
        };
  return { guide, interview, transcript, finalization };
}

function profileStore(): Map<string, EvaluationProfile> {
  return new Map([
    ['profile-default', profile('profile-default', 'default', true)],
    ['profile-alternate', profile('profile-alternate', 'Alternate evidence', false)],
  ]);
}

function profile(profileId: string, name: string, isDefault: boolean): EvaluationProfile {
  return evaluationProfileSchema.parse({
    profileId,
    name,
    description: 'Guide-independent evaluation profile.',
    coderPrompt: 'Evaluate every item from exact final participant evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'practice', name: 'Observed practice', order: 0 }],
    items: [
      {
        itemId: 'practice-1',
        dimensionId: 'practice',
        name: 'Documented practice',
        codingInstruction: 'Assess observable documented practice.',
        order: 0,
        anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
          score,
          criterion: `Observed-practice criterion ${String(score)}.`,
        })),
      },
    ],
    isDefault,
    createdAt: T0,
    updatedAt: T0,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function conflict(evaluationId: string) {
  return failure({
    code: 'duplicate_conflict' as const,
    resource: 'evaluation_run' as const,
    identity: evaluationId,
  });
}
