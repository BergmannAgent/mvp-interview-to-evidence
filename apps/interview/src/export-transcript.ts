import type { InterviewGuide, MvpTranscriptGap, SupportedLocale } from '@orgscience/contracts';

import type { DisplayTranscriptTurn } from './model.js';

export type TranscriptExportFormat = 'markdown' | 'json' | 'text';

interface TranscriptExportInput {
  readonly format: TranscriptExportFormat;
  readonly language: SupportedLocale;
  readonly guide: InterviewGuide;
  readonly interviewId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly turns: readonly DisplayTranscriptTurn[];
  readonly technicalGaps?: readonly MvpTranscriptGap[];
}

export type OrderedTranscriptEntry =
  | { readonly kind: 'turn'; readonly value: DisplayTranscriptTurn }
  | { readonly kind: 'technical_gap'; readonly value: MvpTranscriptGap };

const EXPORT_MESSAGES = {
  de: {
    interviewId: 'Interview-ID',
    language: 'Sprache',
    languageName: 'Deutsch',
    startedAt: 'Beginn',
    endedAt: 'Ende',
    aiInterviewer: 'AI-Interviewer',
    participant: 'Interviewpartner',
    interrupted: 'unterbrochen',
    technicalGaps: 'Technische Lücken',
  },
  en: {
    interviewId: 'Interview ID',
    language: 'Language',
    languageName: 'English',
    startedAt: 'Started',
    endedAt: 'Ended',
    aiInterviewer: 'AI interviewer',
    participant: 'Participant',
    interrupted: 'interrupted',
    technicalGaps: 'Technical gaps',
  },
} as const satisfies Readonly<Record<SupportedLocale, Record<string, string>>>;

export function downloadTranscript(input: TranscriptExportInput): void {
  const content = createTranscriptExport(input);
  const extension = input.format === 'markdown' ? 'md' : input.format === 'text' ? 'txt' : 'json';
  const mimeType =
    input.format === 'markdown'
      ? 'text/markdown;charset=utf-8'
      : input.format === 'text'
        ? 'text/plain;charset=utf-8'
        : 'application/json;charset=utf-8';
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `interview-${input.interviewId}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createTranscriptExport(input: TranscriptExportInput): string {
  const messages = EXPORT_MESSAGES[input.language];
  if (input.format === 'json') {
    return JSON.stringify(
      {
        schemaVersion: 2,
        interviewId: input.interviewId,
        language: input.language,
        guide: {
          id: input.guide.id,
          title: input.guide.title,
          sourceLanguage: input.guide.sourceLanguage ?? input.language,
        },
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        turns: input.turns,
        technicalGaps: input.technicalGaps ?? [],
      },
      null,
      2,
    );
  }

  const metadata = [
    input.format === 'markdown' ? `# ${input.guide.title}` : input.guide.title,
    '',
    `${messages.interviewId}: ${input.interviewId}`,
    `${messages.language}: ${messages.languageName}`,
    `${messages.startedAt}: ${formatTimestamp(input.startedAt, input.language)}`,
    `${messages.endedAt}: ${formatTimestamp(input.endedAt, input.language)}`,
    '',
  ];
  let gapNumber = 0;
  const entries = orderedTranscriptEntries(input.turns, input.technicalGaps ?? []).flatMap(
    (entry) => {
      if (entry.kind === 'turn') {
        const turn = entry.value;
        const speaker =
          turn.speaker === 'ai_interviewer' ? messages.aiInterviewer : messages.participant;
        const interruption = turn.interrupted ? ` · ${messages.interrupted}` : '';
        const label = `${formatTimestamp(turn.occurredAt, input.language)} · ${speaker}${interruption}`;
        return input.format === 'markdown'
          ? [`## ${label}`, '', turn.text, '']
          : [`[${label}]`, turn.text, ''];
      }

      gapNumber += 1;
      const gap = entry.value;
      const label = `${messages.technicalGaps} ${String(gapNumber)} · ${formatTimestamp(
        gap.occurredAt,
        input.language,
      )}`;
      return input.format === 'markdown'
        ? [`## ${label}`, '', gap.description, '']
        : [`[${label}]`, gap.description, ''];
    },
  );
  return [...metadata, ...entries].join('\n').trimEnd() + '\n';
}

export function orderedTranscriptEntries(
  turns: readonly DisplayTranscriptTurn[],
  technicalGaps: readonly MvpTranscriptGap[],
): OrderedTranscriptEntry[] {
  return [
    ...turns.map((turn): OrderedTranscriptEntry => ({ kind: 'turn', value: turn })),
    ...technicalGaps.map((gap): OrderedTranscriptEntry => ({ kind: 'technical_gap', value: gap })),
  ].sort((left, right) => left.value.sequenceNumber - right.value.sequenceNumber);
}

function formatTimestamp(timestamp: string, language: SupportedLocale): string {
  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
