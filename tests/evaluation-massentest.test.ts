import { describe, expect, it, vi } from 'vitest';

import {
  evaluationProfileSchema,
  mvpInterviewSessionSchema,
  profileEvaluationCodingOutputSchema,
  type ProfileEvaluationCodingOutput,
} from '../packages/contracts/src/index.js';
import type { EvaluationCoder } from '../apps/backend/src/application/evaluations/evaluation-coder.js';
import { MastraEvaluationCoder } from '../apps/backend/src/infrastructure/mastra/mastra-evaluation-coder.js';
import {
  compareMassentestRuns,
  massentestComparisonMarkdown,
  massentestFingerprint,
  massentestInputMarkdown,
  massentestRunMarkdown,
  prepareMassentestInputs,
  readDefaultMassentestProfile,
  runEvaluationMassentest,
} from '../scripts/evaluation-massentest.js';

const MODEL = { mode: 'provider', provider: 'openai', model: 'openai/test-model' } as const;

describe('standalone evaluation massentest', () => {
  it('reads only the saved default with GET and preserves its edited content and name', async () => {
    const saved = profile();
    const { profileId, name, description, isDefault, createdAt, updatedAt } = saved;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          profiles: [{ profileId, name, description, isDefault, createdAt, updatedAt }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ profile: saved }));
    expect(await readDefaultMassentestProfile('http://localhost:3100', fetcher)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) expect(options?.method).toBe('GET');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      '/api/v1/evaluation-profiles/profile-saved-default',
    );
  });

  it('rejects ambiguous default profiles and unstarted or unresolved-partial transcripts before any coding', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ profiles: [] }));
    await expect(readDefaultMassentestProfile('http://localhost:3100', fetcher)).rejects.toThrow(
      'Exactly one',
    );
    expect(() =>
      prepareMassentestInputs(profile(), { ...session(), status: 'ready', startedAt: null }),
    ).toThrow('Synthetic transcript');
    expect(() =>
      prepareMassentestInputs(profile(), { ...session(), partialTranscript: 'Unconfirmed audio' }),
    ).toThrow('Synthetic transcript');
  });

  it('executes ten sequential independent runs with identical frozen inputs and different run IDs', async () => {
    const inputs = prepareMassentestInputs(profile(), session());
    let active = 0;
    let calls = 0;
    const snapshots: string[] = [];
    const ids = new Set<string>();
    const coder: EvaluationCoder = {
      model: MODEL,
      async code(input, context) {
        expect(active).toBe(0);
        active += 1;
        snapshots.push(massentestFingerprint(input));
        ids.add(context.runId);
        calls += 1;
        await Promise.resolve();
        active -= 1;
        // A provider must not be able to contaminate the following run's input.
        input.profile.profile.description = 'temporary mutation';
        return { ok: true, output: coding([3, 5]) };
      },
    };
    const runs = await runEvaluationMassentest(inputs, {
      batchId: 'batch-independent',
      coder,
      providerCalls: () => calls,
      signal: new AbortController().signal,
    });
    expect(calls).toBe(10);
    expect(ids.size).toBe(10);
    expect(new Set(snapshots).size).toBe(1);
    expect(inputs.profileDocument.profile.description).toBe('Edited current default');
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
    expect(compareMassentestRuns(inputs.profile, runs).exactScoreAgreement).toBe(true);
  });

  it('records a failed slot honestly and continues without replacing it with an eleventh run', async () => {
    const inputs = prepareMassentestInputs(profile(), session());
    let calls = 0;
    const coder: EvaluationCoder = {
      model: MODEL,
      async code() {
        calls += 1;
        return calls === 4
          ? {
              ok: false,
              error: { code: 'rate_limited', message: 'Provider rate limit.', retryable: true },
            }
          : { ok: true, output: coding([4, 5]) };
      },
    };
    const runs = await runEvaluationMassentest(inputs, {
      batchId: 'batch-failure',
      coder,
      providerCalls: () => calls,
      signal: new AbortController().signal,
    });
    const failed = runs[3];
    expect(failed?.status).toBe('failed');
    if (!failed) throw new Error('Missing failure slot');
    expect(massentestRunMarkdown(failed)).toContain('rate_limited');
    expect(calls).toBe(10);
    expect(compareMassentestRuns(inputs.profile, runs)).toMatchObject({
      completedRuns: 9,
      failedRuns: 1,
      exactScoreAgreement: false,
    });
    expect(massentestComparisonMarkdown(inputs, runs)).toContain(
      'Eine vollständige 10/10-Stabilität kann nicht behauptet',
    );
  });

  it('compares item vectors rather than treating equal overall means as stability', async () => {
    const inputs = prepareMassentestInputs(profile(), session());
    let calls = 0;
    const runs = await runEvaluationMassentest(inputs, {
      batchId: 'batch-swapped',
      providerCalls: () => calls,
      signal: new AbortController().signal,
      coder: {
        model: MODEL,
        async code() {
          calls += 1;
          return { ok: true, output: coding(calls % 2 === 0 ? [3, 5] : [5, 3]) };
        },
      },
    });
    const compared = compareMassentestRuns(inputs.profile, runs);
    expect(new Set(compared.overallScores)).toEqual(new Set([4]));
    expect(compared).toMatchObject({ distinctScoreVectors: 2, exactScoreAgreement: false });
    expect(compared.items[0]).toMatchObject({
      mean: 4,
      minimum: 3,
      maximum: 5,
      standardDeviation: 1,
      scoredCount: 10,
      modalValues: ['3', '5'],
      modalCount: 5,
    });
  });

  it('excludes non-scores from means and compares evidence choices separately from rationale wording', async () => {
    const inputs = prepareMassentestInputs(profile(), session());
    let calls = 0;
    const runs = await runEvaluationMassentest(inputs, {
      batchId: 'batch-text',
      providerCalls: () => calls,
      signal: new AbortController().signal,
      coder: {
        model: MODEL,
        async code() {
          calls += 1;
          const output = coding([4, null]);
          const first = output.items[0];
          if (!first) throw new Error('Missing item');
          first.rationale = `Grounded rationale ${String(calls)}`;
          return { ok: true, output };
        },
      },
    });
    const compared = compareMassentestRuns(inputs.profile, runs);
    expect(compared.overallScores).toEqual(Array.from({ length: 10 }, () => 4));
    expect(compared.items[1]).toMatchObject({
      scoredCount: 0,
      mean: null,
      minimum: null,
      standardDeviation: null,
      statusCounts: { insufficient_evidence: 10 },
      modalValues: ['insufficient_evidence'],
      modalCount: 10,
    });
    expect(compared.items[0]).toMatchObject({
      evidenceChoicesStable: true,
      rationaleTextsStable: false,
    });
    expect(compared.exactScoreAgreement).toBe(true);
    expect(massentestRunMarkdown(runs[0] ?? missingRun())).toContain('Evidenz');
  });

  it('counts the production coder repair as a provider call, not as another independent run', async () => {
    const inputs = prepareMassentestInputs(profile(), session());
    let providerCalls = 0;
    const coder = new MastraEvaluationCoder({
      model: 'openai/test-model',
      generator: {
        async generate() {
          providerCalls += 1;
          return { object: providerCalls % 2 === 1 ? { invalid: true } : coding([4, 5]) };
        },
      },
    });
    const runs = await runEvaluationMassentest(inputs, {
      batchId: 'batch-repairs',
      coder,
      providerCalls: () => providerCalls,
      signal: new AbortController().signal,
    });
    expect(runs).toHaveLength(10);
    expect(runs.every((run) => run.providerCalls === 2 && run.status === 'completed')).toBe(true);
    expect(compareMassentestRuns(inputs.profile, runs).providerCalls).toBe(20);
  });

  it('changes fingerprints only when canonical source content changes', () => {
    expect(massentestFingerprint({ a: 1, b: 2 })).toBe(massentestFingerprint({ b: 2, a: 1 }));
    expect(massentestFingerprint({ a: 1 })).not.toBe(massentestFingerprint({ a: 2 }));
  });

  it('exports an input Markdown snapshot without rewriting any canonical turn text', () => {
    const inputs = prepareMassentestInputs(profile(), session());
    const markdown = massentestInputMarkdown(inputs);
    for (const turn of inputs.session.transcript) {
      expect(markdown).toContain(`\n\n${turn.text}\n`);
      expect(markdown).toContain(`${String(turn.sequenceNumber)} - ${turn.speaker}`);
    }
    expect(markdown).toContain(inputs.transcriptFingerprint);
  });
});

function profile() {
  return evaluationProfileSchema.parse({
    profileId: 'profile-saved-default',
    name: 'default',
    description: 'Edited current default',
    coderPrompt: 'Evaluate observed decisions and learning without score targets.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'practice', name: 'Practice', order: 0 }],
    items: ['decisions', 'learning'].map((itemId, order) => ({
      itemId,
      dimensionId: 'practice',
      name: itemId,
      order,
      codingInstruction: `Evaluate ${itemId}.`,
      anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
        score,
        criterion: `Practice level ${String(score)}`,
      })),
    })),
    isDefault: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  });
}

function session() {
  return mvpInterviewSessionSchema.parse({
    interviewId: 'interview-synthetic',
    guideId: 'guide-synthetic',
    guideTitle: 'Synthetic interview',
    language: 'de',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-10-01T10:00:00.000Z',
    endedAt: '2026-10-01T10:02:00.000Z',
    updatedAt: '2026-10-01T10:02:01.000Z',
    finalizedAt: '2026-10-01T10:02:01.000Z',
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: 'ai-synthetic',
        interviewId: 'interview-synthetic',
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'What did you do?',
        occurredAt: '2026-10-01T10:00:00.000Z',
        guideReference: null,
        interrupted: false,
      },
      {
        turnId: 'participant-synthetic',
        interviewId: 'interview-synthetic',
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'We documented decisions and reviewed the outcome with our team.',
        occurredAt: '2026-10-01T10:01:00.000Z',
        guideReference: null,
        interrupted: false,
      },
    ],
  });
}

function coding(scores: readonly (number | null)[]): ProfileEvaluationCodingOutput {
  return profileEvaluationCodingOutputSchema.parse({
    items: ['decisions', 'learning'].map((itemId, index) => {
      const score = scores[index] ?? null;
      return {
        itemId,
        dimensionId: 'practice',
        status: score === null ? 'insufficient_evidence' : 'scored',
        score,
        confidence: score === null ? 0 : 0.8,
        supportingEvidence:
          score === null
            ? []
            : [
                {
                  turnId: 'participant-synthetic',
                  sequenceNumber: 2,
                  verbatimExcerpt:
                    'We documented decisions and reviewed the outcome with our team.',
                  inference: null,
                  additionalSources: [],
                },
              ],
        counterEvidence: [],
        missingInformation: score === null ? ['No supported score for this item.'] : [],
        rationale: 'Only the observed practice was considered.',
      };
    }),
    rationale: 'Grounded synthetic evaluation.',
    participantDetails: { age: null, position: null },
  });
}

function missingRun(): never {
  throw new Error('Expected a run');
}
