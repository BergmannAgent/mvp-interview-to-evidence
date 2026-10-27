import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseInterviewGuideMarkdown } from './parser.js';
import { STABLE_GUIDE_ID_VERSION } from './stable-id.js';
import {
  INTERVIEW_GUIDE_LIMITS,
  type GuideParseIssueCode,
  type ParsedInterviewGuide,
} from './types.js';

const COMPLETE_GUIDE = `# Interviewleitfaden: Organizational Resilience

## Einführung

### Hauptfrage
Welche Rolle haben Sie im Unternehmen?

#### Vertiefungsfragen

- Seit wann arbeiten Sie in dieser Position?
- Für welche Bereiche tragen Sie Verantwortung?
- Mit welchen anderen Abteilungen arbeiten Sie zusammen?

## Umgang mit unerwarteten Ereignissen

### Hauptfrage
Bitte erzählen Sie von einer unerwarteten Situation, die Ihr Unternehmen besonders herausgefordert hat.

#### Vertiefungsfragen

- Was ist genau passiert?
- Wann wurde erkannt, dass eine kritische Situation vorliegt?
- Wer war an der Reaktion beteiligt?
- Welche Entscheidungen wurden getroffen?
- Was hat gut funktioniert?
- Wo gab es Schwierigkeiten?

### Hauptfrage
Wie bereitet sich Ihr Unternehmen auf unerwartete Ereignisse vor?

#### Vertiefungsfragen

- Gibt es formale Notfallpläne?
- Werden diese Pläne regelmäßig getestet?
- Wer ist für deren Aktualisierung verantwortlich?
- Können Sie ein konkretes Beispiel nennen?

## Abschluss

### Hauptfrage
Gibt es noch etwas, das für das Thema wichtig ist und bisher nicht angesprochen wurde?`;

const COMPLETE_ENGLISH_GUIDE = `# Interview guide: Organizational Resilience

## Introduction

### Main question
What is your role in the organization?

#### Follow-up questions

- How long have you worked in this role?
- Which areas are you responsible for?

## Closing

### Main question
Is there anything else relevant to the topic that we have not discussed yet?`;

describe('parseInterviewGuideMarkdown', () => {
  it('parses the committed English example with explicit English markers', () => {
    const markdown = readFileSync(
      new URL('../../../../examples/organizational-resilience.en.md', import.meta.url),
      'utf8',
    );
    const guide = expectEnglishSuccess(markdown);

    expect(guide.sourceLanguage).toBe('en');
    expect(guide.sections.map((section) => section.mainQuestions.length)).toEqual([1, 2, 1]);
    expect(
      guide.sections.flatMap((section) =>
        section.mainQuestions.map((question) => question.followUpQuestions.length),
      ),
    ).toEqual([3, 6, 4, 0]);
  });

  it('parses the English structure and keeps its content unchanged', () => {
    const guide = expectEnglishSuccess(COMPLETE_ENGLISH_GUIDE);

    expect(guide).toMatchObject({
      sourceLanguage: 'en',
      title: 'Interview guide: Organizational Resilience',
      sections: [
        {
          title: 'Introduction',
          mainQuestions: [
            {
              text: 'What is your role in the organization?',
              followUpQuestions: [
                { text: 'How long have you worked in this role?' },
                { text: 'Which areas are you responsible for?' },
              ],
            },
          ],
        },
        {
          title: 'Closing',
          mainQuestions: [
            {
              text: 'Is there anything else relevant to the topic that we have not discussed yet?',
            },
          ],
        },
      ],
    });
  });

  it('rejects language-mismatched and mixed marker sets with English diagnostics', () => {
    const result = parseInterviewGuideMarkdown(
      `# Interview guide
## Introduction
### Hauptfrage
What is your role?
#### Follow-up questions
- How long have you held it?`,
      'en',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toContain('UNEXPECTED_HEADING');
      expect(result.issues.every((issue) => !/[äöüß]/iu.test(issue.message))).toBe(true);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'NO_MAIN_QUESTION',
            message: 'The guide must contain at least one main question.',
          }),
        ]),
      );
    }
  });

  it('separates English IDs while preserving the pinned German v1 IDs', () => {
    const markdown = `# Guide
## Section
### Main question
What happened?`;
    const english = expectEnglishSuccess(markdown);
    const germanMarkers = expectSuccess(markdown.replace('### Main question', '### Hauptfrage'));

    expect(collectIds(english)).not.toEqual(collectIds(germanMarkers));
  });

  it('parses the committed Organizational Resilience example without changing its structure', () => {
    const markdown = readFileSync(
      new URL('../../../../examples/organizational-resilience.md', import.meta.url),
      'utf8',
    );
    const guide = expectSuccess(markdown);

    expect(guide.sections.map((section) => section.mainQuestions.length)).toEqual([1, 2, 1]);
    expect(
      guide.sections.flatMap((section) =>
        section.mainQuestions.map((question) => question.followUpQuestions.length),
      ),
    ).toEqual([3, 6, 4, 0]);
  });

  it('parses the required complete interview guide shape', () => {
    const guide = expectSuccess(COMPLETE_GUIDE);

    expect(guide.title).toBe('Interviewleitfaden: Organizational Resilience');
    expect(guide.sections).toHaveLength(3);
    expect(guide.sections[0]).toMatchObject({
      title: 'Einführung',
      mainQuestions: [
        {
          text: 'Welche Rolle haben Sie im Unternehmen?',
          followUpQuestions: [
            { text: 'Seit wann arbeiten Sie in dieser Position?' },
            { text: 'Für welche Bereiche tragen Sie Verantwortung?' },
            { text: 'Mit welchen anderen Abteilungen arbeiten Sie zusammen?' },
          ],
        },
      ],
    });
    expect(guide.sections[1]?.mainQuestions).toHaveLength(2);
    expect(guide.sections[1]?.mainQuestions[0]?.followUpQuestions).toHaveLength(6);
    expect(guide.sections[1]?.mainQuestions[1]?.followUpQuestions).toHaveLength(4);
    expect(guide.sections[2]?.mainQuestions[0]).toMatchObject({
      text: 'Gibt es noch etwas, das für das Thema wichtig ist und bisher nicht angesprochen wurde?',
      followUpQuestions: [],
    });
  });

  it('uses the shared structural names and zero-based positions', () => {
    const guide = expectSuccess(COMPLETE_GUIDE);

    expect(guide.sections.map((section) => section.position)).toEqual([0, 1, 2]);
    expect(
      guide.sections.map((section) => section.mainQuestions.map((question) => question.position)),
    ).toEqual([[0], [0, 1], [0]]);
    expect(guide.sections[0]?.mainQuestions[0]?.followUpQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          position: 0,
          text: 'Seit wann arbeiten Sie in dieser Position?',
        }),
      ]),
    );
    expect(guide.sections[0]?.mainQuestions[0]).not.toHaveProperty('followUps');
  });

  it('accepts a BOM, CRLF line endings, and blank lines without changing IDs', () => {
    const canonical = expectSuccess(COMPLETE_GUIDE);
    const withTransportDifferences = expectSuccess(
      `\uFEFF\r\n${COMPLETE_GUIDE.replace(/\n/gu, '\r\n\r\n')}\r\n`,
    );

    expect(collectIds(withTransportDifferences)).toEqual(collectIds(canonical));
  });

  it('derives IDs from normalized content and hierarchy', () => {
    const composed = expectSuccess(`# Leitfaden
## Einführung
### Hauptfrage
Welche Rolle haben Sie?`);
    const normalizedVariation = expectSuccess(`#  Leitfaden
## Einfu\u0308hrung
###   Hauptfrage
Welche   Rolle   haben   Sie?`);

    expect(collectIds(normalizedVariation)).toEqual(collectIds(composed));
  });

  it('scopes every node ID to the complete normalized guide structure', () => {
    const first = expectSuccess(`# Gleicher Titel
## Abschnitt
### Hauptfrage
Erste Frage?`);
    const second = expectSuccess(`# Gleicher Titel
## Abschnitt
### Hauptfrage
Andere Frage?`);

    expect(first.id).not.toBe(second.id);
    expect(collectIds(first)).not.toEqual(collectIds(second));
    expect(collectIds(first).some((id) => new Set(collectIds(second)).has(id))).toBe(false);
  });

  it('keeps the v1 stable-ID algorithm pinned by a compact golden fixture', () => {
    const guide = expectSuccess(`# Leitfaden
## Abschnitt
### Hauptfrage
Was ist passiert?
#### Vertiefungsfragen
- Wann?`);

    expect(STABLE_GUIDE_ID_VERSION).toBe('v1');
    expect(collectIds(guide)).toEqual([
      'guide:v1:11egcfc0zfn3k4',
      'section:v1:0ozmaxy0of26d6',
      'main-question:v1:1738g100q32vdc',
      'follow-up:v1:1twcsb902o3lvl',
    ]);
  });

  it('keeps IDs unique for repeated equal content in the same hierarchy', () => {
    const guide = expectSuccess(`# Leitfaden
## Abschnitt
### Hauptfrage
Gleiche Frage?
#### Vertiefungsfragen
- Gleiche Vertiefung?
- Gleiche Vertiefung?
### Hauptfrage
Gleiche Frage?`);
    const ids = collectIds(guide);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    {
      name: 'a missing title and missing main question',
      markdown: '',
      codes: ['TITLE_MISSING', 'NO_MAIN_QUESTION'],
    },
    {
      name: 'an empty title and question text',
      markdown: '#   \n## Abschnitt\n### Hauptfrage',
      codes: [
        'TITLE_EMPTY',
        'MAIN_QUESTION_TEXT_MISSING',
        'SECTION_WITHOUT_MAIN_QUESTION',
        'NO_MAIN_QUESTION',
      ],
    },
    {
      name: 'a duplicate title',
      markdown: '# Leitfaden\n# Zweiter Titel\n## Abschnitt\n### Hauptfrage\nFrage?',
      codes: ['DUPLICATE_TITLE'],
    },
    {
      name: 'a title after a section',
      markdown: '## Abschnitt\n# Leitfaden\n### Hauptfrage\nFrage?',
      codes: ['SECTION_BEFORE_TITLE', 'TITLE_OUT_OF_ORDER'],
    },
    {
      name: 'a main question before any section',
      markdown: '# Leitfaden\n### Hauptfrage\nFrage?',
      codes: ['MAIN_QUESTION_BEFORE_SECTION', 'NO_MAIN_QUESTION'],
    },
    {
      name: 'an empty section title',
      markdown: '# Leitfaden\n## \n### Hauptfrage\nFrage?',
      codes: ['SECTION_TITLE_EMPTY', 'MAIN_QUESTION_BEFORE_SECTION', 'NO_MAIN_QUESTION'],
    },
    {
      name: 'a section without a main question',
      markdown: '# Leitfaden\n## Leer\n## Mit Frage\n### Hauptfrage\nFrage?',
      codes: ['SECTION_WITHOUT_MAIN_QUESTION'],
    },
    {
      name: 'follow-ups before a main question',
      markdown: '# Leitfaden\n## Abschnitt\n#### Vertiefungsfragen\n- Nachfrage?',
      codes: [
        'FOLLOW_UP_BEFORE_MAIN_QUESTION',
        'FOLLOW_UP_OUTSIDE_LIST',
        'SECTION_WITHOUT_MAIN_QUESTION',
        'NO_MAIN_QUESTION',
      ],
    },
    {
      name: 'an empty follow-up block',
      markdown: '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?\n#### Vertiefungsfragen',
      codes: ['FOLLOW_UP_LIST_EMPTY'],
    },
    {
      name: 'an empty follow-up value',
      markdown: '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?\n#### Vertiefungsfragen\n- ',
      codes: ['FOLLOW_UP_TEXT_EMPTY', 'FOLLOW_UP_LIST_EMPTY'],
    },
    {
      name: 'a bullet without the required follow-up heading',
      markdown: '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?\n- Nachfrage?',
      codes: ['FOLLOW_UP_OUTSIDE_LIST'],
    },
    {
      name: 'unexpected headings and prose',
      markdown:
        '# Leitfaden\n## Abschnitt\nZusatztext\n### Andere Überschrift\n### Hauptfrage\nFrage?',
      codes: ['UNEXPECTED_CONTENT', 'UNEXPECTED_HEADING'],
    },
  ])('rejects $name with typed, line-addressable issues', ({ markdown, codes }) => {
    const result = parseInterviewGuideMarkdown(markdown);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected parsing to fail.');
    }

    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(codes));
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: expect.any(Number),
          code: expect.any(String),
          message: expect.any(String),
        }),
      ]),
    );
    expect(result.issues.every((issue) => issue.line >= 1 && issue.message.length > 0)).toBe(true);
  });

  it('reports a repeated follow-up heading on its exact source line', () => {
    const result = parseInterviewGuideMarkdown(`# Leitfaden
## Abschnitt
### Hauptfrage
Frage?
#### Vertiefungsfragen
#### Vertiefungsfragen
- Nachfrage?`);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected parsing to fail.');
    }

    expect(result.issues).toContainEqual({
      line: 6,
      code: 'DUPLICATE_FOLLOW_UP_HEADING',
      message: expect.any(String),
    });
  });

  it.each([
    {
      code: 'TITLE_TOO_LONG',
      markdown: `# ${'x'.repeat(301)}\n## Abschnitt\n### Hauptfrage\nFrage?`,
    },
    {
      code: 'SECTION_TITLE_TOO_LONG',
      markdown: `# Leitfaden\n## ${'x'.repeat(301)}\n### Hauptfrage\nFrage?`,
    },
    {
      code: 'MAIN_QUESTION_TEXT_TOO_LONG',
      markdown: `# Leitfaden\n## Abschnitt\n### Hauptfrage\n${'x'.repeat(2_001)}`,
    },
    {
      code: 'FOLLOW_UP_TEXT_TOO_LONG',
      markdown: `# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?\n#### Vertiefungsfragen\n- ${'x'.repeat(2_001)}`,
    },
  ] as const)('rejects content beyond the shared contract as $code', ({ code, markdown }) => {
    const result = parseInterviewGuideMarkdown(markdown);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toContain(code);
    }
  });

  it('rejects an oversized source before attempting to parse its structure', () => {
    const result = parseInterviewGuideMarkdown('x'.repeat(1_000_001));

    expect(result).toEqual({
      success: false,
      issues: [
        {
          line: 1,
          code: 'SOURCE_TOO_LONG',
          message: expect.any(String),
        },
      ],
    });
  });

  it('rejects excessive line cardinality before materializing a line array', () => {
    const line = `${'x'.repeat(47)}\n`;
    const result = parseInterviewGuideMarkdown(line.repeat(20_000));

    expect(result).toEqual({
      success: false,
      issues: [
        {
          line: 20_001,
          code: 'TOO_MANY_LINES',
          message: expect.any(String),
        },
      ],
    });
  });

  it('caps malformed-source diagnostics to a bounded issue response', () => {
    const result = parseInterviewGuideMarkdown(
      ['# Leitfaden', '## Abschnitt', ...Array.from({ length: 250 }, () => 'ungueltig')].join('\n'),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toHaveLength(100);
      expect(result.issues.at(-1)?.code).toBe('TOO_MANY_ISSUES');
    }
  });

  it.each([
    {
      code: 'TOO_MANY_SECTIONS',
      markdown: [
        '# Leitfaden',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumSections + 1 },
          (_, index) => `## Abschnitt ${String(index)}`,
        ),
      ].join('\n'),
    },
    {
      code: 'TOO_MANY_MAIN_QUESTIONS',
      markdown: [
        '# Leitfaden',
        '## Abschnitt',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumMainQuestions + 1 },
          (_, index) => `### Hauptfrage\nFrage ${String(index)}?`,
        ),
      ].join('\n'),
    },
    {
      code: 'TOO_MANY_FOLLOW_UP_QUESTIONS',
      markdown: [
        '# Leitfaden',
        '## Abschnitt',
        '### Hauptfrage',
        'Frage?',
        '#### Vertiefungsfragen',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions + 1 },
          (_, index) => `- Vertiefung ${String(index)}?`,
        ),
      ].join('\n'),
    },
    {
      code: 'TOO_MANY_QUESTIONS',
      markdown: [
        '# Leitfaden',
        '## Abschnitt',
        '### Hauptfrage',
        'Frage 0?',
        '#### Vertiefungsfragen',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions },
          (_, index) => `- Vertiefung ${String(index)}?`,
        ),
        ...Array.from(
          {
            length:
              INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions -
              INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
          },
          (_, index) => `### Hauptfrage\nFrage ${String(index + 1)}?`,
        ),
      ].join('\n'),
    },
  ] as const)('rejects guide structure cardinality as $code', ({ code, markdown }) => {
    const result = parseInterviewGuideMarkdown(markdown);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code, line: expect.any(Number), message: expect.any(String) }),
      ]);
    }
  });

  it('reports the configured total-question limit in the user-facing issue', () => {
    const markdown = [
      '# Leitfaden',
      '## Abschnitt',
      '### Hauptfrage',
      'Frage 0?',
      '#### Vertiefungsfragen',
      ...Array.from(
        { length: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions },
        (_, index) => `- Vertiefung ${String(index)}?`,
      ),
      ...Array.from(
        {
          length:
            INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions -
            INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
        },
        (_, index) => `### Hauptfrage\nFrage ${String(index + 1)}?`,
      ),
    ].join('\n');
    const result = parseInterviewGuideMarkdown(markdown);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'TOO_MANY_QUESTIONS',
          message: expect.stringContaining('1.750'),
        }),
      ]);
    }
  });

  it('accepts the exact maximum line count', () => {
    const base = '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?';
    const markdown = `${base}${'\n'.repeat(20_000 - 4)}`;

    expect(expectSuccess(markdown).sections).toHaveLength(1);
  });

  it('accepts the exact section and main-question limits', () => {
    const maximumSections = expectSuccess(
      [
        '# Leitfaden',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumSections },
          (_, index) => `## Abschnitt ${String(index)}\n### Hauptfrage\nFrage ${String(index)}?`,
        ),
      ].join('\n'),
    );
    expect(maximumSections.sections).toHaveLength(INTERVIEW_GUIDE_LIMITS.maximumSections);

    const maximumMainQuestions = expectSuccess(
      [
        '# Leitfaden',
        '## Abschnitt',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumMainQuestions },
          (_, index) => `### Hauptfrage\nFrage ${String(index)}?`,
        ),
      ].join('\n'),
    );
    expect(maximumMainQuestions.sections[0]?.mainQuestions).toHaveLength(
      INTERVIEW_GUIDE_LIMITS.maximumMainQuestions,
    );
  });

  it('accepts the exact follow-up and total-question limits', () => {
    const maximumFollowUps = expectSuccess(
      [
        '# Leitfaden',
        '## Abschnitt',
        '### Hauptfrage',
        'Frage?',
        '#### Vertiefungsfragen',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions },
          (_, index) => `- Vertiefung ${String(index)}?`,
        ),
      ].join('\n'),
    );
    expect(maximumFollowUps.sections[0]?.mainQuestions[0]?.followUpQuestions).toHaveLength(
      INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions,
    );

    const additionalMainQuestionCount =
      INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions -
      INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions -
      1;
    const maximumTotal = expectSuccess(
      [
        '# Leitfaden',
        '## Abschnitt',
        '### Hauptfrage',
        'Frage 0?',
        '#### Vertiefungsfragen',
        ...Array.from(
          { length: INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions },
          (_, index) => `- Vertiefung ${String(index)}?`,
        ),
        ...Array.from(
          { length: additionalMainQuestionCount },
          (_, index) => `### Hauptfrage\nFrage ${String(index + 1)}?`,
        ),
      ].join('\n'),
    );
    const totalQuestionCount = maximumTotal.sections[0]?.mainQuestions.reduce(
      (count, question) => count + 1 + question.followUpQuestions.length,
      0,
    );
    expect(totalQuestionCount).toBe(INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions);
  });

  it('counts an optional BOM consistently at the source-size boundary', () => {
    const base = '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?';
    const maximumSource = `\uFEFF${padMarkdownToLength(base, 999_999)}`;
    expect(expectSuccess(maximumSource).title).toBe('Leitfaden');

    const oversized = parseInterviewGuideMarkdown(`\uFEFF${padMarkdownToLength(base, 1_000_000)}`);
    expect(oversized).toEqual({
      success: false,
      issues: [expect.objectContaining({ code: 'SOURCE_TOO_LONG', line: 1 })],
    });
  });
});

function padMarkdownToLength(markdown: string, length: number): string {
  if (markdown.length >= length) throw new Error('Padding target must exceed Markdown length');
  return `${markdown}\n${' '.repeat(length - markdown.length - 1)}`;
}

function expectSuccess(markdown: string): ParsedInterviewGuide {
  const result = parseInterviewGuideMarkdown(markdown);

  if (!result.success) {
    throw new Error(
      `Expected parsing to succeed, received: ${result.issues
        .map((issue) => `${issue.code}@${String(issue.line)}`)
        .join(', ')}`,
    );
  }

  return result.guide;
}

function expectEnglishSuccess(markdown: string): ParsedInterviewGuide {
  const result = parseInterviewGuideMarkdown(markdown, 'en');

  if (!result.success) {
    throw new Error(
      `Expected English parsing to succeed, received: ${result.issues
        .map((issue) => `${issue.code}@${String(issue.line)}`)
        .join(', ')}`,
    );
  }

  return result.guide;
}

function collectIds(guide: ParsedInterviewGuide): string[] {
  return [
    guide.id,
    ...guide.sections.flatMap((section) => [
      section.id,
      ...section.mainQuestions.flatMap((question) => [
        question.id,
        ...question.followUpQuestions.map((followUp) => followUp.id),
      ]),
    ]),
  ];
}

const _issueCodeTypeCheck: GuideParseIssueCode = 'NO_MAIN_QUESTION';
void _issueCodeTypeCheck;
