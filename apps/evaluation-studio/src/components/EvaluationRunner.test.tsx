import type { EvaluableInterview } from '@orgscience/api-client';
import {
  calculateProfileScores,
  PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
  type EvaluationProfileItem,
  type EvaluationProfileSummary,
  type ProfileEvaluationSnapshot,
} from '@orgscience/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  EvaluationRunner,
  evaluationRunnerAvailability,
  preferredEvaluationProfileId,
  preferredEvaluableInterviewId,
  transcriptExtent,
  type EvaluationRunnerProps,
} from './EvaluationRunner.js';

describe('EvaluationRunner', () => {
  it('prefers the default profile and the most recently finalized interview', () => {
    const profiles = [
      profile('profile-custom', 'Custom', false),
      profile('profile-default', 'Default', true),
    ];
    const older = interview('interview-old', '2026-08-20T12:00:00.000Z');
    const newer = interview('interview-new', '2026-08-21T12:00:00.000Z');

    expect(preferredEvaluationProfileId(profiles)).toBe('profile-default');
    expect(preferredEvaluableInterviewId([newer, older])).toBe('interview-new');
    expect(preferredEvaluationProfileId([])).toBeNull();
    expect(preferredEvaluableInterviewId([])).toBeNull();
  });

  it('derives transcript extent from the canonical persisted turns', () => {
    expect(transcriptExtent(interview('interview-1'))).toEqual({
      totalTurns: 2,
      participantTurns: 1,
      characterCount: 49,
    });
  });

  it('blocks start and retry for a dirty profile while keeping refresh available', () => {
    expect(
      evaluationRunnerAvailability({
        selectedInterviewId: 'interview-1',
        selectedProfileId: 'profile-default',
        evaluation: failedEvaluation(true),
        operation: null,
        dirtyProfile: true,
      }),
    ).toEqual({
      canRefresh: true,
      canStart: false,
      canRetry: false,
      runBlockedByDirtyProfile: true,
    });
  });

  it('renders interview metadata, default profile, and the ready start action', () => {
    const html = renderRunner({ evaluation: notStartedEvaluation() });

    expect(html).toContain('Auswertung');
    expect(html).toContain('Interviewleitfaden Test');
    expect(html).toContain('interview-1');
    expect(html).toContain('2 Turns');
    expect(html).toContain('1 Antwort');
    expect(html).toContain('<strong>Default</strong>');
    expect(html).not.toContain('<select');
    expect(html).toContain('Bereit');
    expect(html).toContain('Auswertung starten');
    expect(html).not.toContain('Erneut ausführen');
  });

  it('keeps the start action disabled while the persisted run state is unknown', () => {
    const html = renderRunner({ evaluation: null });

    expect(html).toContain('Status nicht verfügbar');
    expect(button(html, 'Auswertung starten')).toContain('disabled');
  });

  it('renders a retryable failure and disables retry when the profile is dirty', () => {
    const html = renderRunner({
      evaluation: failedEvaluation(true),
      dirtyProfile: true,
    });

    expect(html).toContain('Fehlgeschlagen · erneut ausführbar');
    expect(html).toContain('Testlauf gesperrt');
    expect(html).toContain('Erneut versuchen');
    expect(button(html, 'Erneut versuchen')).toContain('disabled');
    expect(button(html, 'Ergebnis aktualisieren')).not.toContain('disabled');
  });

  it('exposes persisted completion as successful and explicitly rerunnable', () => {
    const html = renderRunner({ evaluation: completedEvaluation() });

    expect(html).toContain('Erfolgreich');
    expect(html).toContain('evaluation-1');
    expect(html).toContain('Erneut ausführen');
    expect(button(html, 'Erneut ausführen')).not.toContain('disabled');
  });

  it('uses the selected interview language for English runner chrome and formats', () => {
    const englishInterview = interview('interview-en', '2026-08-21T12:00:00.000Z', 'en');
    const html = renderRunner({
      interviews: [englishInterview],
      selectedInterviewId: 'interview-en',
      evaluation: null,
    });

    expect(html).toContain('Evaluation');
    expect(html).toContain('Interview language');
    expect(html).toContain('English');
    expect(html).toContain('2 turns');
    expect(html).toContain('1 answer');
    expect(html).toContain('Start evaluation');
    expect(html).not.toContain('Testauswertung');
  });

  it('shows incomplete interviews and warns without pretending that they ended', () => {
    const completed = interview('paused-interview');
    const paused: EvaluableInterview = {
      ...completed,
      summary: { ...completed.summary, status: 'paused' },
      session: {
        ...completed.session,
        status: 'paused',
        endedAt: null,
        finalizedAt: null,
        updatedAt: '2026-09-30T12:00:00.000Z',
      },
    };
    const html = renderRunner({
      interviews: [paused],
      selectedInterviewId: 'paused-interview',
      evaluation: null,
    });
    expect(html).toContain('Pausiert');
    expect(html).toContain('Letzte Aktivität');
    expect(html).toContain('Auswertung des bisherigen Transkripts');
    expect(html).toContain('fehlende Antworten werden nicht erfunden');
    expect(html).not.toContain('<dt>Abgeschlossen</dt>');
    expect(preferredEvaluableInterviewId([completed, paused])).toBe('paused-interview');
  });

  it('supports English interface labels for a German interview without relabelling its source language', () => {
    const html = renderRunner({ interfaceLanguage: 'en' });
    expect(html).toContain('Interview language');
    expect(html).toContain('Deutsch');
    expect(html).toContain('Start evaluation');
    expect(html).not.toContain('Auswertung starten');
  });
});

function renderRunner(overrides: Partial<EvaluationRunnerProps> = {}): string {
  return renderToStaticMarkup(
    <EvaluationRunner
      interviews={[interview('interview-1')]}
      profiles={[profile('profile-default', 'Default', true)]}
      selectedInterviewId="interview-1"
      selectedProfileId="profile-default"
      evaluation={null}
      loadingInterviews={false}
      operation={null}
      dirtyProfile={false}
      error={null}
      onReloadInterviews={() => undefined}
      onRefresh={() => undefined}
      onStart={() => undefined}
      onRetry={() => undefined}
      {...overrides}
    />,
  );
}

function interview(
  interviewId: string,
  endedAt = '2026-08-21T12:00:00.000Z',
  language: 'de' | 'en' = 'de',
): EvaluableInterview {
  return {
    summary: {
      interviewId,
      guideId: 'guide-1',
      language,
      guideTitle: 'Interviewleitfaden Test',
      status: 'completed',
      currentMainQuestionId: null,
      activeWorkflowRunId: null,
      createdAt: '2026-08-21T10:00:00.000Z',
      updatedAt: endedAt,
      startedAt: '2026-08-21T10:05:00.000Z',
    },
    session: {
      interviewId,
      guideId: 'guide-1',
      language,
      guideTitle: 'Interviewleitfaden Test',
      status: 'completed',
      stateVersion: 1,
      currentQuestionIndex: 1,
      totalQuestions: 1,
      currentQuestion: null,
      startedAt: '2026-08-21T10:05:00.000Z',
      endedAt,
      updatedAt: endedAt,
      partialTranscript: null,
      transcript: [
        {
          turnId: `${interviewId}-turn-1`,
          interviewId,
          sequenceNumber: 1,
          speaker: 'ai_interviewer',
          turnType: 'main_question',
          text: 'Wie arbeitet Ihre Organisation?',
          occurredAt: '2026-08-21T10:05:05.000Z',
          guideReference: null,
          interrupted: false,
        },
        {
          turnId: `${interviewId}-turn-2`,
          interviewId,
          sequenceNumber: 2,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: 'Sehr strukturiert.',
          occurredAt: '2026-08-21T10:05:20.000Z',
          guideReference: null,
          interrupted: false,
        },
      ],
      technicalGaps: [],
      finalizedAt: endedAt,
    },
  };
}

function profile(profileId: string, name: string, isDefault: boolean): EvaluationProfileSummary {
  return {
    profileId,
    name,
    description: `${name} description`,
    isDefault,
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
  };
}

function notStartedEvaluation(): ProfileEvaluationSnapshot {
  return {
    status: 'not_started',
    interviewId: 'interview-1',
    profileId: 'profile-default',
    profileFingerprint: fingerprint(),
    language: 'de',
    report: null,
    failure: null,
  };
}

function failedEvaluation(retryable: boolean): ProfileEvaluationSnapshot {
  return {
    status: 'failed',
    evaluationId: 'evaluation-1',
    interviewId: 'interview-1',
    profileId: 'profile-default',
    profileFingerprint: fingerprint(),
    language: 'de',
    startedAt: '2026-08-21T12:05:00.000Z',
    failedAt: '2026-08-21T12:05:01.000Z',
    report: null,
    failure: { code: 'provider_error', message: 'Provider unavailable.', retryable },
  };
}

function completedEvaluation(): ProfileEvaluationSnapshot {
  return {
    status: 'completed',
    evaluationId: 'evaluation-1',
    interviewId: 'interview-1',
    profileId: 'profile-default',
    profileFingerprint: fingerprint(),
    language: 'de',
    startedAt: '2026-08-21T12:05:00.000Z',
    completedAt: '2026-08-21T12:05:01.000Z',
    report: {
      schemaVersion: PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
      reportKind: 'evaluation_profile_report',
      evaluationId: 'evaluation-1',
      interviewId: 'interview-1',
      profileId: 'profile-default',
      profileName: 'Default',
      profileUpdatedAt: '2026-08-21T10:00:00.000Z',
      profileFingerprint: fingerprint(),
      transcriptFingerprint: fingerprint(),
      language: 'de',
      profileTranslation: null,
      promptVersion: 'profile-evaluation-coder-v1',
      evaluatedAt: '2026-08-21T12:05:01.000Z',
      model: { mode: 'demo', provider: null, model: null },
      profile: {
        profileId: 'profile-default',
        name: 'Default',
        description: '',
        coderPrompt: 'Code the evidence.',
        scale: { minimum: 1, maximum: 7 },
        dimensions: [{ dimensionId: 'dimension-1', name: 'Dimension', order: 0 }],
        items: [
          {
            itemId: 'item-1',
            dimensionId: 'dimension-1',
            name: 'Item',
            codingInstruction: 'Code this item.',
            order: 0,
            anchors: anchors(),
          },
        ],
      },
      overallAggregate: {
        status: 'complete',
        score: 4,
        scoredItemCount: 1,
        unscoredItemCount: 0,
        totalItemCount: 1,
      },
      calculation: calculateProfileScores(
        {
          dimensions: [{ dimensionId: 'dimension-1' }],
          items: [{ itemId: 'item-1', dimensionId: 'dimension-1' }],
        },
        { 'item-1': 4 },
      ).calculation,
      rationale: 'The available evidence was coded against the selected profile.',
      dimensions: [
        {
          dimensionId: 'dimension-1',
          name: 'Dimension',
          order: 0,
          aggregate: {
            status: 'complete',
            score: 4,
            scoredItemCount: 1,
            unscoredItemCount: 0,
            totalItemCount: 1,
          },
          items: [
            {
              itemId: 'item-1',
              dimensionId: 'dimension-1',
              name: 'Item',
              codingInstruction: 'Code this item.',
              order: 0,
              anchors: anchors(),
              status: 'scored',
              score: 4,
              appliedAnchor: { score: 4, criterion: 'Criterion 4' },
              confidence: 0.8,
              supportingEvidence: [
                {
                  turnId: 'interview-1-turn-2',
                  sequenceNumber: 2,
                  verbatimExcerpt: 'Sehr strukturiert.',
                },
              ],
              counterEvidence: [],
              missingInformation: [],
              rationale: 'The answer provides direct evidence.',
            },
          ],
        },
      ],
    },
    failure: null,
  };
}

function fingerprint(): string {
  return 'a'.repeat(64);
}

function anchors(): EvaluationProfileItem['anchors'] {
  return [
    { score: 1, criterion: 'Criterion 1' },
    { score: 2, criterion: 'Criterion 2' },
    { score: 3, criterion: 'Criterion 3' },
    { score: 4, criterion: 'Criterion 4' },
    { score: 5, criterion: 'Criterion 5' },
    { score: 6, criterion: 'Criterion 6' },
    { score: 7, criterion: 'Criterion 7' },
  ];
}

function button(html: string, label: string): string {
  return (
    [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].find((match) =>
      match[0].includes(label),
    )?.[0] ?? ''
  );
}
