import { existsSync, readFileSync } from 'node:fs';
import {
  calculateProfileScores,
  PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
  profileEvaluationSnapshotSchema,
  type EvaluationProfilePortable,
  type ProfileEvaluationReportItem,
} from '@orgscience/contracts';
import { chromium, type Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EvaluationReportView, type CompletedProfileEvaluation } from './EvaluationReportView.js';

const browserExecutablePath =
  process.env['BROWSER_EXECUTABLE_PATH'] ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : chromium.executablePath());

describe('EvaluationReportView', () => {
  it.skipIf(!existsSync(browserExecutablePath))(
    'centers a full-width long title above wrapping exports without centering report content',
    async () => {
      const evaluation = completedEvaluation('en');
      recalculate(evaluation);
      const html = renderToStaticMarkup(
        <EvaluationReportView
          evaluation={evaluation}
          interviewTitle={
            'Interview about shared responsibility and long-term organizational decisions: ' +
            'LongTermDecisionMakingResponsibility'.repeat(3)
          }
          activeExport="html"
          onExport={() => undefined}
        />,
      );
      const styles = [
        new URL('../../../../packages/design-tokens/src/tokens.css', import.meta.url),
        new URL('../styles.css', import.meta.url),
        new URL('./EvaluationReportView.css', import.meta.url),
      ]
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n');
      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath });
        const page = await browser.newPage();
        for (const width of [1280, 960, 375, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(
            `<style>${styles}</style><main style="max-width: 1040px; margin: 0 auto; padding: 0 20px">${html}</main>`,
          );
          const geometry = await page.evaluate(() => {
            const element = (selector: string): HTMLElement => {
              const selected = document.querySelector<HTMLElement>(selector);
              if (selected === null) throw new Error(`Missing report element: ${selector}`);
              return selected;
            };
            const bounds = (selected: HTMLElement) => {
              const { x, y, width, right, bottom } = selected.getBoundingClientRect();
              return { x, y, width, right, bottom };
            };
            const header = element('.evaluation-report-header');
            return {
              header: bounds(header),
              title: bounds(element('.evaluation-report-header > div:first-child')),
              actions: bounds(element('.evaluation-export-actions')),
              buttons: Array.from(
                document.querySelectorAll<HTMLButtonElement>('.evaluation-export-actions button'),
                bounds,
              ),
              titleAlignment: getComputedStyle(element('#evaluation-report-title')).textAlign,
              statusAlignment: getComputedStyle(element('.evaluation-export-status')).textAlign,
              rationaleAlignment: getComputedStyle(element('.evaluation-report-rationale p'))
                .textAlign,
              tableAlignment: getComputedStyle(element('.evaluation-calculation-table-wrap table'))
                .textAlign,
              headerScrollWidth: header.scrollWidth,
              headerWidth: header.clientWidth,
              documentWidth: document.documentElement.scrollWidth,
            };
          });
          const center = geometry.header.x + geometry.header.width / 2;
          expect(geometry.title.width).toBeCloseTo(geometry.header.width, 0);
          expect(geometry.titleAlignment).toBe('center');
          expect(geometry.actions.y).toBeGreaterThanOrEqual(geometry.title.bottom);
          expect(geometry.buttons).toHaveLength(4);
          const rows = new Map<number, typeof geometry.buttons>();
          for (const button of geometry.buttons) {
            expect(button.x).toBeGreaterThanOrEqual(geometry.header.x - 1);
            expect(button.right).toBeLessThanOrEqual(geometry.header.right + 1);
            const row = rows.get(button.y) ?? [];
            row.push(button);
            rows.set(button.y, row);
          }
          for (const row of rows.values()) {
            const first = row[0];
            const last = row.at(-1);
            if (first === undefined || last === undefined) throw new Error('Missing export row');
            expect((first.x + last.right) / 2).toBeCloseTo(center, 0);
          }
          expect(geometry.statusAlignment).toBe('center');
          expect(['left', 'start']).toContain(geometry.rationaleAlignment);
          expect(geometry.tableAlignment).toBe('left');
          expect(geometry.headerScrollWidth).toBeLessThanOrEqual(geometry.headerWidth);
          expect(geometry.documentWidth).toBeLessThanOrEqual(width);
        }
      } finally {
        await browser?.close();
      }
    },
    30_000,
  );

  it('renders detailed item and report rationales completely without changing stored scores', () => {
    const evaluation = completedEvaluation();
    const item = firstReportItem(evaluation);
    const rationale =
      'The participant described a bounded decision practice. '.repeat(20) +
      '\n\nA broader scope is not supported by the cited statements.';
    item.rationale = rationale;
    evaluation.report.rationale = rationale;
    const original = structuredClone(evaluation);
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
    );
    expect(rationale.length).toBeGreaterThan(800);
    expect(html).toContain(rationale);
    expect(evaluation).toEqual(original);
  });
  it('switches system labels to English while preserving a German report and original quotes', () => {
    const evaluation = completedEvaluation('de');
    evaluation.report.sourceTranscript = {
      interviewStatus: 'paused',
      finalized: false,
      snapshotAt: evaluation.completedAt,
      turnCount: 5,
      ignoredPartial: true,
    };
    const evidence = evaluation.report.dimensions
      .flatMap((dimension) => dimension.items)
      .flatMap((item) => item.supportingEvidence)[0];
    if (evidence === undefined) throw new Error('Missing fixture evidence');
    const original = JSON.stringify(evaluation.report);
    const html = renderToStaticMarkup(
      <EvaluationReportView
        evaluation={evaluation}
        interfaceLanguage="en"
        onExport={() => undefined}
      />,
    );
    expect(html).toContain('Provisional evaluation of the transcript so far');
    expect(html).toContain('Unconfirmed partial transcriptions');
    expect(html).toContain('Supporting evidence');
    expect(html).toContain('<dt>Report language</dt><dd>Deutsch</dd>');
    expect(html).not.toContain('Vorläufige Auswertung');
    expect(html).toContain(evidence.verbatimExcerpt);
    expect(JSON.stringify(evaluation.report)).toBe(original);
  });
  it.each(['de', 'en'] as const)('renders sourced age and position in %s', (language) => {
    const evaluation = completedEvaluation(language);
    const source = {
      turnId: 'participant-details',
      sequenceNumber: 2,
      verbatimExcerpt: 'Ich bin 48 Jahre alt und war Bereichsleiterin.',
    };
    evaluation.report.participantDetails = {
      age: { value: '48 Jahre', source },
      position: { value: 'war Bereichsleiterin', source },
    };
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
    );
    expect(html).toContain(language === 'de' ? 'Interviewperson' : 'Interview participant');
    expect(html).toContain('48 Jahre');
    expect(html).toContain('war Bereichsleiterin');
    expect(html).toContain(source.verbatimExcerpt);
    expect(html).toContain('href="#transcript-turn-participant-details"');
  });

  it('distinguishes missing transcript details from old reports that were not extracted', () => {
    const evaluation = completedEvaluation();
    expect(
      renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      ),
    ).toContain('Nicht erfasst');
    evaluation.report.participantDetails = { age: null, position: null };
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
    );
    expect(html).toContain('Nicht angegeben oder nicht eindeutig');
    expect(html).not.toContain('Nicht erfasst');
  });

  it('escapes untrusted participant details', () => {
    const evaluation = completedEvaluation();
    evaluation.report.participantDetails = {
      age: null,
      position: {
        value: '<script>role</script>',
        source: {
          turnId: 'participant',
          sequenceNumber: 2,
          verbatimExcerpt: '<script>role</script>',
        },
      },
    };
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('renders arbitrary profile dimensions, scores, and every non-score state', () => {
    const html = renderReport();

    expect(html).toContain('Sentinel profile without guide assumptions');
    expect(html).toContain('Dimension Alpha');
    expect(html).toContain('Dimension Beta');
    expect(html.match(/data-item-id=/gu) ?? []).toHaveLength(4);
    expect(html).toContain('Bewertet');
    expect(html).toContain('Unzureichende Evidenz');
    expect(html).toContain('Widersprüchliche Evidenz');
    expect(html).toContain('Nicht anwendbar');
    expect(html).toContain('Angewendeter Anker 5 von 7');
    expect(html).toContain('Alpha score 5 exact criterion');
    expect(html).toContain('Kein numerischer Anker angewendet');
    expect(html).not.toContain('Organizational Resilience');
    expect(html).not.toContain('Robustness');
  });

  it('shows exact evidence, opposing evidence, confidence, and transcript-turn references', () => {
    const html = renderReport();

    expect(html).toContain('Fördernde Evidenz');
    expect(html).toContain('Hemmende Evidenz');
    expect(html).not.toContain('Mehrdeutige Evidenz');
    expect(html).toContain('The participant gave exact supporting evidence.');
    expect(html).toContain('The participant later gave exact counter evidence.');
    expect(html).toContain('href="#transcript-turn-turn-supporting-2"');
    expect(html).toContain('href="#transcript-turn-turn-counter-9"');
    expect(html).toContain('Turn #2');
    expect(html).toContain('Turn #9');
    expect(html).toContain('Konfidenz');
    expect(html).toContain('Hinweis zur KI-generierten Konfidenz');
    expect(html).toContain(
      'keine statistisch kalibrierten Wahrscheinlichkeiten oder Konfidenzintervalle',
    );
    expect(html).toContain('KI-Selbsteinschätzung, keine statistisch validierte Sicherheit.');
    expect(html).toContain('86');
    expect(html).toContain('A concrete example is missing.');
    expect(html).toContain('Auditierbare Begründung');
  });

  it('renders run and model provenance with all export callbacks exposed as buttons', () => {
    const html = renderReport();

    expect(html).toContain('Run- und Modellmetadaten');
    expect(html).toContain('evaluation-sentinel-run');
    expect(html).toContain('interview-sentinel');
    expect(html).toContain('profile-sentinel');
    expect(html).toContain('provider-sentinel');
    expect(html).toContain('model-sentinel-fast');
    expect(html).toContain('profile-evidence-coding-v1');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('b'.repeat(64));

    for (const label of ['JSON', 'CSV', 'Markdown', 'HTML']) {
      expect(html).toContain(`aria-label="Auswertung als ${label} exportieren"`);
    }
  });

  it('announces an active export and a sanitized export error', () => {
    const html = renderToStaticMarkup(
      <EvaluationReportView
        evaluation={completedEvaluation()}
        activeExport="html"
        exportError="Der Export konnte nicht erstellt werden."
        onExport={() => undefined}
      />,
    );

    expect(html).toContain('HTML wird vorbereitet.');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Der Export konnte nicht erstellt werden.');
    expect(html.match(/ disabled=""/gu) ?? []).toHaveLength(4);
  });

  it('renders English report chrome and locale formats without translating evidence', () => {
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={completedEvaluation('en')} onExport={() => undefined} />,
    );

    expect(html).toContain('Completed evaluation');
    expect(html).toContain('AI-generated confidence disclaimer');
    expect(html).toContain('not statistically calibrated probabilities or confidence intervals');
    expect(html).toContain('AI self-assessment, not statistically validated certainty.');
    expect(html).toContain('Insufficient evidence');
    expect(html).toContain('Conflicting evidence');
    expect(html).toContain('Applied anchor 5 of 7');
    expect(html).toContain('Run and model metadata');
    expect(html).toContain('Controlled translation of the derived pilot instrument');
    expect(html).toContain('aria-label="Export evaluation as JSON"');
    expect(html).toContain('The participant gave exact supporting evidence.');
    expect(html).not.toContain('Abgeschlossene Auswertung');
    expect(html).not.toContain('Unzureichende Evidenz');
    expect(html).not.toContain('Ambiguous evidence');
  });

  it('does not relabel legacy evidence as direct', () => {
    const html = renderReport();

    expect(html).toContain('>Evidenz</span>');
    expect(html).not.toContain('evaluation-evidence-type is-direct');
    expect(html).not.toContain('evaluation-evidence-type is-indirect');
    expect(html).not.toContain('evaluation-legacy-evidence-notice');
  });

  it.each(['de', 'en'] as const)(
    'renders a historical report notice once without altering evidence in %s',
    (language) => {
      const evaluation = completedEvaluation(language);
      evaluation.report.legacyEvidenceNotice =
        language === 'de'
          ? 'Historische Evidenz ist im archivierten Originalbericht erhalten.'
          : 'Historical evidence is preserved in the archived original report.';
      const original = structuredClone(evaluation);
      const html = renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      );

      expect(html.match(/evaluation-legacy-evidence-notice/gu)).toHaveLength(1);
      expect(html).toContain(evaluation.report.legacyEvidenceNotice);
      expect(html).toContain('The participant gave exact supporting evidence.');
      expect(html).toContain('The participant later gave exact counter evidence.');
      expect(html).not.toContain('evaluation-evidence-type is-direct');
      expect(html).not.toContain('evaluation-evidence-type is-indirect');
      expect(html).not.toContain('Mehrdeutige Evidenz');
      expect(html).not.toContain('Ambiguous evidence');
      expect(evaluation).toEqual(original);
    },
  );

  it.each(['direct', 'indirect'] as const)(
    'renders a single %s evidence without adding another',
    (evidenceType) => {
      const evaluation = completedEvaluation();
      const item = firstReportItem(evaluation);
      item.supportingEvidence = [
        {
          ...evidence('singleton-source', 2, 'Die Schichtleitung entschied selbst.'),
          evidenceType,
          inference:
            evidenceType === 'indirect'
              ? 'Die Entscheidung deutet auf delegierte Befugnisse hin.'
              : null,
        },
      ];
      const html = renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      );

      expect(html.match(/href="#transcript-turn-singleton-source"/gu)).toHaveLength(1);
      expect(html).toContain('>Evidenz</span>');
      expect(html).not.toContain('>Direkt</span>');
      expect(html).not.toContain('>Indirekt</span>');
      expect(html).toContain('Angewendeter Anker 5 von 7');
      expect(html).toContain('<blockquote>Die Schichtleitung entschied selbst.</blockquote>');
      if (evidenceType === 'indirect') {
        expect(html).toContain(
          '<strong>Ableitung: </strong>Die Entscheidung deutet auf delegierte Befugnisse hin.',
        );
      } else {
        expect(html).not.toContain('evaluation-evidence-inference');
      }
    },
  );

  it.each(['de', 'en'] as const)(
    'renders every evidence direction, source, and inference in %s',
    (language) => {
      const evaluation = completedEvaluation(language);
      const item = firstReportItem(evaluation);
      item.supportingEvidence = [
        {
          ...evidence('direct-source', 12, 'Wir entscheiden eigenständig.'),
          evidenceType: 'direct',
        },
        {
          ...evidence('indirect-source', 13, 'Die Schichtleitung plante um.'),
          evidenceType: 'indirect',
          inference: '<script>Die Aussagen legen eigenständige Entscheidungen nahe.</script>',
          additionalSources: [
            evidence('context-source-1', 14, 'Eine Freigabe war nicht erforderlich.'),
            evidence('context-source-2', 15, 'Es galt für alle Schichten.'),
          ],
        },
      ];
      item.counterEvidence = [
        {
          ...evidence('counter-source-1', 16, 'Bei Investitionen warten wir.'),
          evidenceType: 'direct',
        },
        {
          ...evidence('counter-source-2', 17, 'Die Freigabe kam am nächsten Tag.'),
          evidenceType: 'indirect',
          inference: 'Dies deutet auf eine Grenze der Befugnisse hin.',
          additionalSources: [
            evidence('counter-context-source', 18, 'Ohne Freigabe blieb die Investition gesperrt.'),
          ],
        },
      ];
      const html = renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      );

      for (const source of [
        'direct-source',
        'indirect-source',
        'context-source-1',
        'context-source-2',
        'counter-source-1',
        'counter-source-2',
        'counter-context-source',
      ]) {
        expect(html.match(new RegExp(`href="#transcript-turn-${source}"`, 'gu'))).toHaveLength(1);
      }
      expect(html).toContain(language === 'de' ? '>Evidenz</span>' : '>Evidence</span>');
      expect(html).not.toMatch(
        />(Direkt|Indirekt|Direct|Indirect|Unclassified|Nicht klassifiziert)<\/span>/u,
      );
      expect(html).toContain(
        language === 'de' ? '<strong>Ableitung: </strong>' : '<strong>Inference: </strong>',
      );
      expect(html).toContain('<blockquote>Es galt für alle Schichten.</blockquote>');
      expect(html).toContain(
        '<blockquote>Ohne Freigabe blieb die Investition gesperrt.</blockquote>',
      );
      expect(html).toContain('Dies deutet auf eine Grenze der Befugnisse hin.');
      expect(html.match(/evaluation-evidence-inference/gu)).toHaveLength(2);
      expect(html.match(/evaluation-evidence-list is-/gu)).toHaveLength(8);
      expect(html).toContain(language === 'de' ? 'Fördernde Evidenz' : 'Supporting evidence');
      expect(html).toContain(language === 'de' ? 'Hemmende Evidenz' : 'Counter-evidence');
      expect(html).not.toContain('Mehrdeutige Evidenz');
      expect(html).not.toContain('Ambiguous evidence');
      expect(html).not.toContain('is-ambiguous');
      expect(html).toContain(
        '&lt;script&gt;Die Aussagen legen eigenständige Entscheidungen nahe.&lt;/script&gt;',
      );
      expect(html).not.toContain('<script>');
    },
  );

  it.each(['de', 'en'] as const)(
    'renders unbounded formula results without a seven-point overall scale in %s',
    (language) => {
      for (const result of [-25, 5, 125]) {
        const evaluation = completedEvaluation(language);
        evaluation.report.profile.calculation = { mode: 'formula', expression: String(result) };
        recalculate(evaluation);
        const original = structuredClone(evaluation);
        const html = renderToStaticMarkup(
          <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
        );
        const metric = html.match(/class="evaluation-report-metric"[\s\S]*?<\/div>/u)?.[0] ?? '';
        expect(metric).toContain(`<strong title="${String(result)}">${String(result)}</strong>`);
        expect(metric).not.toContain('/ 7');
        expect(html).toContain(language === 'de' ? 'Berechnungsnachweis' : 'Calculation audit');
        expect(html).toContain('class="evaluation-score"');
        expect(html).toContain('<small>/7</small>');
        expect(evaluation).toEqual(original);
      }
    },
  );

  it.each(['de', 'en'] as const)(
    'keeps large finite formula results compact in the overall metric in %s',
    (language) => {
      for (const result of [1e9, -1e9, 1e308, -1e308]) {
        const evaluation = completedEvaluation(language);
        evaluation.report.profile.calculation = { mode: 'formula', expression: String(result) };
        recalculate(evaluation);
        expect(profileEvaluationSnapshotSchema.safeParse(evaluation).success).toBe(true);
        const original = structuredClone(evaluation);
        const html = renderToStaticMarkup(
          <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
        );
        const metric = html.match(/class="evaluation-report-metric"[\s\S]*?<\/div>/u)?.[0] ?? '';
        const displayed = metric.match(/<strong[^>]*>([^<]*)<\/strong>/u)?.[1];
        const formatted = new Intl.NumberFormat(language, {
          maximumFractionDigits: 2,
          notation: 'scientific',
        }).format(result);

        expect(evaluation.report.overallAggregate.score).toBe(result);
        expect(displayed).toBe(formatted);
        expect(formatted.length).toBeLessThan(12);
        expect(metric).not.toContain('/ 7');
        expect(html).toContain('<small>/7</small>');
        expect(evaluation).toEqual(original);
      }
    },
  );

  it('shows configured weights and weighted contributions with missing and zero exclusions', () => {
    const evaluation = completedEvaluation('en');
    const dimension = evaluation.report.profile.dimensions[0];
    const item = evaluation.report.profile.items[0];
    if (dimension === undefined || item === undefined) throw new Error('Missing profile fixture');
    dimension.weight = 2;
    item.weight = 3;
    recalculate(evaluation);
    const html = renderToStaticMarkup(
      <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
    );
    expect(html).toContain('Weighted mean');
    expect(html).toContain('Mean contribution');
    expect(html).toContain('<td>3</td><td>2</td><td>6</td><td>30</td><td>Included</td>');
    expect(html).toContain('<td>Missing score</td>');
    expect(html).toContain('Dimension calculation');
    item.weight = 0;
    recalculate(evaluation);
    expect(
      renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      ),
    ).toContain('<td>0</td><td>Weight 0</td>');
  });

  it.each(['de', 'en'] as const)(
    'shows only actually evaluated formula references and their zero substitutions in %s',
    (language) => {
      const evaluation = completedEvaluation(language);
      evaluation.report.profile.calculation = {
        mode: 'formula',
        expression: 'item("alpha-missing") + item("alpha-scored") * 20',
      };
      const item = evaluation.report.profile.items[0];
      if (item === undefined) throw new Error('Missing item fixture');
      item.weight = 0;
      recalculate(evaluation);
      const html = renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      );
      expect(html).toContain('<strong title="100">100</strong>');
      expect(html).toContain(
        language === 'de' ? 'Ausgewertete Formelreferenzen' : 'Evaluated formula references',
      );
      expect(html).toContain(
        language === 'de' ? 'Fehlender Wert als 0 eingesetzt' : 'Missing score substituted with 0',
      );
      expect(html).toContain('<code>item(&quot;alpha-missing&quot;)</code>');
      expect(html).toContain('<code>item(&quot;alpha-scored&quot;)</code>');
      expect(html).not.toContain(language === 'de' ? 'Mittelwertbeitrag' : 'Mean contribution');
      expect(html).not.toContain(language === 'de' ? '>Gewicht 0<' : '>Weight 0<');
      expect(html).not.toContain('<td>Included</td>');
      expect(html).toContain(
        'aria-label="' + (language === 'de' ? 'Formelausdruck' : 'Formula expression') + '"',
      );
    },
  );

  it.each(['de', 'en'] as const)(
    'keeps localized runtime errors visible outside the collapsed trace in %s',
    (language) => {
      const evaluation = completedEvaluation(language);
      evaluation.report.profile.calculation = {
        mode: 'formula',
        expression: '1 / item("alpha-missing")',
      };
      recalculate(evaluation);
      const html = renderToStaticMarkup(
        <EvaluationReportView evaluation={evaluation} onExport={() => undefined} />,
      );
      expect(html).toContain(
        language === 'de'
          ? 'Eine Division oder Restwertberechnung durch 0 ist nicht definiert.'
          : 'Division or remainder by zero is undefined.',
      );
      expect(html.indexOf('class="evaluation-calculation-error" role="alert"')).toBeLessThan(
        html.indexOf('<details class="evaluation-calculation-trace"'),
      );
      expect(html).toContain('<details class="evaluation-calculation-trace"><summary>');
      expect(html).not.toContain('<details class="evaluation-calculation-trace" open');
      expect(evaluation.report.overallAggregate.score).toBeNull();
      expect(firstReportItem(evaluation).score).toBe(5);
    },
  );
});

function recalculate(evaluation: CompletedProfileEvaluation): void {
  const scores = new Map(
    evaluation.report.dimensions
      .flatMap((dimension) => dimension.items)
      .map((item) => [item.itemId, item.score]),
  );
  const calculated = calculateProfileScores(evaluation.report.profile, scores);
  evaluation.report.calculation = calculated.calculation;
  evaluation.report.overallAggregate = calculated.overallAggregate;
  for (const dimension of evaluation.report.dimensions) {
    const aggregate = calculated.dimensions.find(
      (entry) => entry.dimensionId === dimension.dimensionId,
    )?.aggregate;
    if (aggregate !== undefined) dimension.aggregate = aggregate;
  }
}

function firstReportItem(evaluation: CompletedProfileEvaluation): ProfileEvaluationReportItem {
  const item = evaluation.report.dimensions[0]?.items[0];
  if (item === undefined) throw new Error('Expected an item in the test report');
  return item;
}

function renderReport(): string {
  return renderToStaticMarkup(
    <EvaluationReportView evaluation={completedEvaluation()} onExport={() => undefined} />,
  );
}

function completedEvaluation(language: 'de' | 'en' = 'de'): CompletedProfileEvaluation {
  const profile: EvaluationProfilePortable = {
    profileId: 'profile-sentinel',
    name: 'Sentinel profile without guide assumptions',
    description: 'A generic profile created only for this rendering test.',
    coderPrompt: 'Code only from exact participant evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [
      { dimensionId: 'dimension-alpha', name: 'Dimension Alpha', order: 0 },
      { dimensionId: 'dimension-beta', name: 'Dimension Beta', order: 1 },
    ],
    items: [
      profileItem('alpha-scored', 'dimension-alpha', 'Alpha scored item', 0),
      profileItem('alpha-missing', 'dimension-alpha', 'Alpha missing item', 1),
      profileItem('beta-conflict', 'dimension-beta', 'Beta conflicting item', 0),
      profileItem('beta-na', 'dimension-beta', 'Beta not-applicable item', 1),
    ],
  };
  const [scored, missing, conflicting, notApplicable] = profile.items;
  if (
    scored === undefined ||
    missing === undefined ||
    conflicting === undefined ||
    notApplicable === undefined
  ) {
    throw new Error('The evaluation test profile is incomplete');
  }

  const reportItems = {
    scored: {
      ...scored,
      status: 'scored' as const,
      score: 5 as const,
      appliedAnchor: scored.anchors[4],
      confidence: 0.86,
      supportingEvidence: [
        evidence('turn-supporting-2', 2, 'The participant gave exact supporting evidence.'),
      ],
      counterEvidence: [],
      missingInformation: [],
      rationale: 'Observed evidence matches the fifth anchor.',
    },
    missing: {
      ...missing,
      status: 'insufficient_evidence' as const,
      score: null,
      appliedAnchor: null,
      confidence: 0.28,
      supportingEvidence: [],
      counterEvidence: [],
      missingInformation: ['A concrete example is missing.'],
      rationale: 'The transcript contains no observable example.',
    },
    conflicting: {
      ...conflicting,
      status: 'conflicting' as const,
      score: null,
      appliedAnchor: null,
      confidence: 0.52,
      supportingEvidence: [
        evidence('turn-supporting-5', 5, 'The participant first described a formal process.'),
      ],
      counterEvidence: [
        evidence('turn-counter-9', 9, 'The participant later gave exact counter evidence.'),
      ],
      missingInformation: ['The applicable scope remains unclear.'],
      rationale: 'The two exact statements cannot be reconciled from the transcript.',
    },
    notApplicable: {
      ...notApplicable,
      status: 'not_applicable' as const,
      score: null,
      appliedAnchor: null,
      confidence: 0.94,
      supportingEvidence: [],
      counterEvidence: [],
      missingInformation: [],
      rationale: 'The participant explicitly established that the item does not apply.',
    },
  };

  const snapshot = profileEvaluationSnapshotSchema.parse({
    status: 'completed',
    evaluationId: 'evaluation-sentinel-run',
    interviewId: 'interview-sentinel',
    profileId: profile.profileId,
    profileFingerprint: 'a'.repeat(64),
    language,
    startedAt: '2026-08-21T14:00:00.000Z',
    completedAt: '2026-08-21T14:01:05.000Z',
    failure: null,
    report: {
      schemaVersion: PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
      reportKind: 'evaluation_profile_report',
      evaluationId: 'evaluation-sentinel-run',
      interviewId: 'interview-sentinel',
      profileId: profile.profileId,
      profileName: profile.name,
      profileUpdatedAt: '2026-08-21T13:45:00.000Z',
      profileFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      language,
      profileTranslation:
        language === 'en'
          ? {
              overlayId: 'default-or-evaluation-profile-en',
              overlayVersion: '1.0.0',
              overlayFingerprintSha256: 'c'.repeat(64),
            }
          : null,
      promptVersion: 'profile-evidence-coding-v1',
      model: { mode: 'provider', provider: 'provider-sentinel', model: 'model-sentinel-fast' },
      profile,
      dimensions: [
        {
          ...profile.dimensions[0],
          aggregate: {
            status: 'partial',
            score: 5,
            scoredItemCount: 1,
            unscoredItemCount: 1,
            totalItemCount: 2,
          },
          items: [reportItems.scored, reportItems.missing],
        },
        {
          ...profile.dimensions[1],
          aggregate: {
            status: 'not_scored',
            score: null,
            scoredItemCount: 0,
            unscoredItemCount: 2,
            totalItemCount: 2,
          },
          items: [reportItems.conflicting, reportItems.notApplicable],
        },
      ],
      overallAggregate: {
        status: 'partial',
        score: 5,
        scoredItemCount: 1,
        unscoredItemCount: 3,
        totalItemCount: 4,
      },
      calculation: calculateProfileScores(profile, { 'alpha-scored': 5 }).calculation,
      rationale: 'The generic report preserves scores and explicit non-score decisions.',
      evaluatedAt: '2026-08-21T14:01:05.000Z',
    },
  });

  if (snapshot.status !== 'completed') throw new Error('Expected a completed evaluation');
  return snapshot;
}

function profileItem(
  itemId: string,
  dimensionId: string,
  name: string,
  order: number,
): EvaluationProfilePortable['items'][number] {
  return {
    itemId,
    dimensionId,
    name,
    codingInstruction: `Assess ${name} only from observed participant evidence.`,
    order,
    anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
      score,
      criterion:
        itemId === 'alpha-scored' && score === 5
          ? 'Alpha score 5 exact criterion'
          : `${name} score ${String(score)} criterion`,
    })) as EvaluationProfilePortable['items'][number]['anchors'],
  };
}

function evidence(turnId: string, sequenceNumber: number, verbatimExcerpt: string) {
  return { turnId, sequenceNumber, verbatimExcerpt };
}
