import { readFileSync } from 'node:fs';

import { interviewGuideSchema, type InterviewGuide } from '@orgscience/contracts';
import { parseInterviewGuideMarkdown } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import {
  buildSyntheticParticipantAnswers,
  SyntheticParticipant,
} from '../scripts/realtime-synthetic-participant.js';

function canonicalGuide(): InterviewGuide {
  const sourceMarkdown = readFileSync(
    new URL('../guides/interviewleitfaden-organizational-resilience-9-items.md', import.meta.url),
    'utf8',
  );
  const parsed = parseInterviewGuideMarkdown(sourceMarkdown, 'de');
  if (!parsed.success) throw new Error('The canonical guide did not parse.');
  return interviewGuideSchema.parse({
    ...parsed.guide,
    sourceMarkdown,
    createdAt: '2026-10-01T10:00:00.000Z',
  });
}

describe('synthetic realtime participant', () => {
  it('provides participant statements for all twelve main and thirty-nine follow-up questions', () => {
    const guide = canonicalGuide();
    const answers = buildSyntheticParticipantAnswers(guide);
    expect(answers.size).toBe(51);
    for (const answer of answers.values()) {
      expect(answer.trim().length).toBeGreaterThan(20);
      expect(answer).not.toContain('?');
    }
  });

  it('keeps authority initially incomplete and resolves it only after a clarification', () => {
    const guide = canonicalGuide();
    const responsibility = guide.sections[0]?.mainQuestions[1];
    if (!responsibility) throw new Error('Missing responsibility question.');
    const participant = new SyntheticParticipant(guide);
    const first = participant.responseFor(responsibility.id, 'main_question');
    expect(first).toContain('B-Freigabespur');
    expect(first).not.toContain('25.000');
    const clarification = participant.responseFor(
      responsibility.id,
      'clarification_question',
      'Eigene Entscheidungsbefugnisse in der B-Spur',
    );
    expect(clarification).toContain('Produktion, Instandhaltung, Lager und Versand');
    expect(clarification).toContain('25.000 Euro');
  });

  it('answers the guide metric follow-up ambiguously, then defines its distinct denominator', () => {
    const guide = canonicalGuide();
    const robustness = guide.sections[1]?.mainQuestions[0];
    const metricQuestion = robustness?.followUpQuestions[4];
    if (!robustness || !metricQuestion) throw new Error('Missing robustness metric question.');
    const participant = new SyntheticParticipant(guide);
    expect(participant.responseFor(metricQuestion.id, 'follow_up_question')).not.toContain('95');
    const clarification = participant.responseFor(
      metricQuestion.id,
      'clarification_question',
      'Definition des gruenen Ampelstatus',
    );
    expect(clarification).toContain('95 Prozent');
    expect(clarification).toContain('kritisch markierten Kundenauftraege');
    expect(clarification).toContain('nicht den Gesamtausfall');
  });

  it('rejects unknown question IDs and an incompatible guide rather than fabricating facts', () => {
    const guide = canonicalGuide();
    const participant = new SyntheticParticipant(guide);
    expect(() => participant.responseFor('unknown', 'main_question')).toThrow(
      'No synthetic answer',
    );
    expect(() => new SyntheticParticipant({ ...guide, sourceLanguage: 'en' })).toThrow(
      'canonical German',
    );
    const changed = structuredClone(guide);
    const question = changed.sections[0]?.mainQuestions[0];
    if (!question) throw new Error('Missing role question.');
    question.text = 'Different question?';
    expect(() => new SyntheticParticipant(changed)).toThrow('does not match');
  });
});
