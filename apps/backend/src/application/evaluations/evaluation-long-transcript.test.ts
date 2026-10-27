import { readFileSync } from 'node:fs';

import {
  evaluationProfileDocumentSchema,
  mvpInterviewSessionSchema,
  type GuideQuestionReference,
  type MvpInterviewSession,
  type MvpTranscriptTurn,
} from '@orgscience/contracts';
import { parseInterviewGuideMarkdown, type InterviewGuideSnapshot } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import { loadOrganizationalResilienceEvaluationAssets } from '../../infrastructure/research/index.js';
import { buildDefaultEvaluationProfile } from '../evaluation-profiles/default-evaluation-profile.js';
import { DemoEvaluationCoder } from './demo-evaluation-coder.js';
import { validateEvaluationTranscript } from './evaluation-guardrails.js';

const INTERVIEW_ID = 'interview-long-transcript';
const STARTED_AT_MS = Date.parse('2026-08-19T10:00:00.000Z');
const assets = loadOrganizationalResilienceEvaluationAssets();

describe('deterministic long-transcript evaluation fixture', () => {
  it('preserves all nine items reproducibly without fabricating demo scores', async () => {
    const guide = loadGuide();
    const storedProfile = buildDefaultEvaluationProfile(assets, '2026-08-19T09:59:00.000Z');
    const profile = evaluationProfileDocumentSchema.parse({
      schemaVersion: 1,
      profile: {
        profileId: storedProfile.profileId,
        name: storedProfile.name,
        description: storedProfile.description,
        coderPrompt: storedProfile.coderPrompt,
        scale: storedProfile.scale,
        dimensions: storedProfile.dimensions,
        items: storedProfile.items,
      },
    });
    const session = buildLongSession(guide);
    const coder = new DemoEvaluationCoder();

    expect(session.transcript).toHaveLength(116);
    expect(validateEvaluationTranscript(session)).toEqual({ ok: true, value: session });

    const first = await coder.code(
      { profile, session },
      { runId: 'long-transcript-run-1', signal: new AbortController().signal },
    );
    const second = await coder.code(
      { profile, session },
      { runId: 'long-transcript-run-2', signal: new AbortController().signal },
    );

    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.output.items.map((item) => item.itemId)).toEqual([
      'rob-01',
      'rob-02',
      'rob-03',
      'rob-04',
      'agi-01',
      'agi-02',
      'agi-03',
      'int-01',
      'int-02',
    ]);
    expect(
      first.output.items.every(
        (item) =>
          item.status === 'insufficient_evidence' &&
          item.score === null &&
          item.supportingEvidence.length === 0,
      ),
    ).toBe(true);
  });
});

function loadGuide(): InterviewGuideSnapshot {
  const sourceMarkdown = readFileSync(
    'guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md',
    'utf8',
  );
  const parsed = parseInterviewGuideMarkdown(sourceMarkdown);
  if (!parsed.success) throw new Error('Expected mapped long-transcript guide to parse');
  return {
    ...parsed.guide,
    sourceMarkdown,
    createdAt: new Date(STARTED_AT_MS).toISOString(),
  };
}

function buildLongSession(guide: InterviewGuideSnapshot): MvpInterviewSession {
  const questions = guide.sections.flatMap((section) =>
    section.mainQuestions.flatMap((mainQuestion) => [
      {
        text: mainQuestion.text,
        turnType: 'main_question' as const,
        reference: {
          kind: 'main_question' as const,
          guideId: guide.id,
          sectionId: section.id,
          mainQuestionId: mainQuestion.id,
        },
      },
      ...mainQuestion.followUpQuestions.map((followUp) => ({
        text: followUp.text,
        turnType: 'follow_up_question' as const,
        reference: {
          kind: 'follow_up_question' as const,
          guideId: guide.id,
          sectionId: section.id,
          mainQuestionId: mainQuestion.id,
          followUpQuestionId: followUp.id,
        },
      })),
    ]),
  );
  const transcript: MvpTranscriptTurn[] = questions.flatMap((question, index) => {
    const aiSequence = index * 2 + 1;
    const participantSequence = aiSequence + 1;
    return [
      transcriptTurn(
        aiSequence,
        'ai_interviewer',
        question.turnType,
        question.text,
        question.reference,
      ),
      transcriptTurn(
        participantSequence,
        'participant',
        'participant_answer',
        `Antwort ${String(index + 1)}: Wir nutzen fuer diesen Aspekt dokumentierte Ablaeufe, konkrete Verantwortlichkeiten und regelmaessige Ueberpruefungen.`,
        question.reference,
      ),
    ];
  });
  const endedAtMs = STARTED_AT_MS + (transcript.length + 1) * 1_000;
  const finalizedAtMs = endedAtMs + 1_000;

  return mvpInterviewSessionSchema.parse({
    interviewId: INTERVIEW_ID,
    guideId: guide.id,
    guideTitle: guide.title,
    status: 'completed',
    currentQuestionIndex: questions.length,
    totalQuestions: questions.length,
    currentQuestion: null,
    startedAt: new Date(STARTED_AT_MS).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    updatedAt: new Date(finalizedAtMs).toISOString(),
    partialTranscript: null,
    transcript,
    technicalGaps: [],
    finalizedAt: new Date(finalizedAtMs).toISOString(),
  });
}

function transcriptTurn(
  sequenceNumber: number,
  speaker: MvpTranscriptTurn['speaker'],
  turnType: MvpTranscriptTurn['turnType'],
  text: string,
  guideReference: GuideQuestionReference,
): MvpTranscriptTurn {
  return {
    turnId: `long-turn-${String(sequenceNumber)}`,
    interviewId: INTERVIEW_ID,
    sequenceNumber,
    speaker,
    turnType,
    text,
    occurredAt: new Date(STARTED_AT_MS + sequenceNumber * 1_000).toISOString(),
    guideReference,
    interrupted: false,
  };
}
