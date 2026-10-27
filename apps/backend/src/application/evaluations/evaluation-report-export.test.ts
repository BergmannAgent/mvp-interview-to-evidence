import {
  calculateProfileScores,
  profileEvaluationReportSchema,
  type EvaluationReport,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { exportEvaluationReport } from './evaluation-report-export.js';

describe('profile evaluation report exports', () => {
  it.each(['de', 'en'] as const)(
    'exports weights, exclusions and the effective weighted contributions in %s',
    (language) => {
      const report = fixture(language);
      report.profile.dimensions[0]!.weight = 2;
      report.profile.dimensions[1]!.weight = 0;
      report.profile.items[0]!.weight = 3;
      const weighted = recalculate(report);
      expect(weighted.overallAggregate.score).toBe(2);
      for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
        const exported = exportEvaluationReport(weighted, format).body;
        expect(exported).toContain(format === 'markdown' ? 'weighted\\_mean' : 'weighted_mean');
        expect(exported).toContain(format === 'markdown' ? 'missing\\_score' : 'missing_score');
        expect(exported).toContain(format === 'markdown' ? 'zero\\_weight' : 'zero_weight');
        expect(exported).toContain('clarity-2');
        expect(exported).toContain('learning-1');
        if (format === 'json')
          expect(JSON.parse(exported).calculation).toEqual(weighted.calculation);
        if (format === 'markdown' || format === 'html') expect(exported).toContain('2 / 7');
      }
      const csv = exportEvaluationReport(weighted, 'csv').body;
      for (const column of [
        'dimension_weight',
        'item_weight',
        'effective_weight',
        'effective_contribution',
        'excluded_item_ids_json',
        'calculation_trace_json',
      ]) {
        expect(csv).toContain(`"${column}"`);
      }
      expect(csv).toContain('"12"');
    },
  );

  it.each(['de', 'en'] as const)(
    'exports an unbounded formula result and null-to-zero reference IDs in %s',
    (language) => {
      const report = fixture(language);
      report.profile.calculation = {
        mode: 'formula',
        expression: 'item("clarity-1") * 10 + item("clarity-2")',
      };
      const formula = recalculate(report);
      expect(formula.overallAggregate.score).toBe(20);
      const markdown = exportEvaluationReport(formula, 'markdown').body;
      const html = exportEvaluationReport(formula, 'html').body;
      for (const artifact of [markdown, html]) {
        expect(artifact).toContain('20');
        expect(artifact).not.toContain('20 / 7');
        expect(artifact).not.toContain('4 / 7');
        expect(artifact).toContain('2 / 7');
        expect(artifact).toContain('6 / 7');
        expect(artifact).toContain('clarity-2');
        expect(artifact).toContain(language === 'de' ? 'als 0 eingesetzt' : 'substituted with 0');
      }
      expect(JSON.parse(exportEvaluationReport(formula, 'json').body).calculation).toEqual(
        formula.calculation,
      );
      const csv = exportEvaluationReport(formula, 'csv').body;
      expect(csv).toContain('"zero_substituted_ids_json"');
      expect(csv).toContain('"custom_formula"');
      expect(csv).toContain('item(""clarity-1"") * 10 + item(""clarity-2"")');
    },
  );

  it.each(['de', 'en'] as const)(
    'exports calculation failures without restoring the old mean in %s',
    (language) => {
      const report = fixture(language);
      report.profile.calculation = { mode: 'formula', expression: 'item("clarity-1") / 0' };
      const failed = recalculate(report);
      expect(failed.overallAggregate.score).toBeNull();
      for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
        const exported = exportEvaluationReport(failed, format).body;
        expect(exported).toContain(
          format === 'markdown' ? 'division\\_by\\_zero' : 'division_by_zero',
        );
        expect(exported).not.toContain('4 / 7');
        if (format === 'json')
          expect(JSON.parse(exported).calculation.error).toEqual(failed.calculation.error);
      }
    },
  );

  it('neutralizes formula expressions in CSV and escapes calculation errors in readable exports', () => {
    const report = fixture('en');
    report.profile.calculation = { mode: 'formula', expression: '-item("clarity-1") * 10' };
    const formula = recalculate(report);
    expect(exportEvaluationReport(formula, 'csv').body).toContain('"\'-item(""clarity-1"") * 10"');
    formula.calculation.error = { code: 'division_by_zero', message: '<script>untrusted</script>' };
    for (const format of ['markdown', 'html'] as const) {
      const exported = exportEvaluationReport(formula, format).body;
      expect(exported).not.toContain('<script>');
      expect(exported).toContain('&lt;script&gt;');
    }
  });

  it.each(['de', 'en'] as const)(
    'preserves detailed multiline rationales in every %s export',
    (language) => {
      const report = fixture(language);
      const rationale =
        'The cited practice fits the selected anchor. '.repeat(24) +
        '\n\nThe remaining scope is not established by the interview.';
      const first = report.dimensions[0]?.items[0];
      if (first === undefined) throw new Error('Missing report fixture');
      first.rationale = rationale;
      report.rationale = rationale;
      const parsed = profileEvaluationReportSchema.parse(report);
      expect(rationale.length).toBeGreaterThan(800);
      for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
        const body = exportEvaluationReport(parsed, format).body;
        if (format === 'json') {
          const exported = JSON.parse(body);
          expect(exported.rationale).toBe(rationale);
          expect(exported.dimensions[0].items[0].rationale).toBe(rationale);
        } else {
          expect(body).toContain(format === 'csv' ? rationale : rationale.replaceAll('\n', '<br>'));
        }
      }
    },
  );
  it.each(['de', 'en'] as const)(
    'marks incomplete sources and excluded partial text in all %s exports',
    (language) => {
      const report = fixture(language);
      report.sourceTranscript = {
        interviewStatus: 'paused',
        finalized: false,
        snapshotAt: report.evaluatedAt,
        turnCount: 3,
        ignoredPartial: true,
      };
      expect(profileEvaluationReportSchema.parse(report).sourceTranscript).toEqual(
        report.sourceTranscript,
      );
      const notice = language === 'de' ? 'Vorläufige Auswertung' : 'Provisional evaluation';
      for (const format of ['csv', 'markdown', 'html'] as const) {
        const exported = exportEvaluationReport(report, format).body;
        expect(exported).toContain(notice);
        expect(exported).toContain(report.sourceTranscript.snapshotAt);
        expect(exported).toContain(
          language === 'de' ? 'Unbestätigte partielle' : 'Unconfirmed partial',
        );
        expect(exported).toContain('A concrete participant claim.');
      }
      expect(JSON.parse(exportEvaluationReport(report, 'json').body).sourceTranscript).toEqual(
        report.sourceTranscript,
      );
    },
  );
  it.each(['de', 'en'] as const)(
    'preserves participant details and their quotes in all %s exports',
    (language) => {
      const report = fixture(language);
      report.participantDetails = {
        age: null,
        position: {
          value: 'war Bereichsleiterin',
          source: {
            turnId: 'participant-details',
            sequenceNumber: 2,
            verbatimExcerpt: 'Ich war Bereichsleiterin.',
          },
        },
      };
      for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
        const artifact = exportEvaluationReport(report, format).body;
        expect(artifact).toContain('war Bereichsleiterin');
        expect(artifact).toContain('Ich war Bereichsleiterin.');
        expect(artifact).toContain('participant-details');
        if (format === 'markdown' || format === 'html')
          expect(artifact).toContain(
            language === 'de' ? 'Nicht angegeben oder nicht eindeutig' : 'Not stated or unclear',
          );
      }
      expect(JSON.parse(exportEvaluationReport(report, 'json').body).participantDetails).toEqual(
        report.participantDetails,
      );
      expect(exportEvaluationReport(report, 'csv').body).toContain('participant_details_json');
    },
  );

  it('escapes participant source content in readable exports', () => {
    const report = fixture();
    report.participantDetails = {
      age: null,
      position: {
        value: '<script>role</script>',
        source: { turnId: 'source', sequenceNumber: 2, verbatimExcerpt: '<script>role</script>' },
      },
    };
    for (const format of ['html', 'markdown'] as const) {
      const artifact = exportEvaluationReport(report, format).body;
      expect(artifact).not.toContain('<script>');
      expect(artifact).toContain('&lt;script&gt;');
    }
  });
  it('exports the canonical report unchanged as JSON and includes the profile in the filename', () => {
    const report = fixture();
    const artifact = exportEvaluationReport(report, 'json');

    expect(JSON.parse(artifact.body)).toEqual(report);
    expect(artifact.fileName).toBe(
      'interview-interview-export-profile-profile-export-evaluation.json',
    );
  });

  it('writes one CSV row per item with lossless JSON evidence and formula neutralization', () => {
    const artifact = exportEvaluationReport(fixture(), 'csv');

    expect(artifact.body.split('\r\n')).toHaveLength(5);
    expect(artifact.body).toContain('"score"');
    expect(artifact.body).toContain('"confidence_notice"');
    expect(artifact.body).toContain('keine statistisch kalibrierten Wahrscheinlichkeiten');
    expect(artifact.body).toContain('"anchors_json"');
    expect(artifact.body).toContain('"transcript_fingerprint"');
    expect(artifact.body).toContain('"prompt_version"');
    expect(artifact.body).toContain('"model_name"');
    expect(artifact.body).toContain('"overall_score"');
    expect(artifact.body).toContain('"report_rationale"');
    expect(artifact.body).toContain('profile-evidence-coding-v1');
    expect(artifact.body).toContain('b'.repeat(64));
    expect(artifact.body).toContain('"2"');
    expect(artifact.body).toContain('"6"');
    expect(artifact.body).toContain('"\'=FORMULA item"');
    expect(artifact.body).toContain('turn-support-1');
    expect(artifact.body).toContain('counter claim');
    expect(artifact.body).toContain('Decision transparency criterion 7');
  });

  it('renders arbitrary dimensions, scores, non-scores, anchors, and evidence consistently', () => {
    const report = fixture();
    const markdown = exportEvaluationReport(report, 'markdown').body;
    const html = exportEvaluationReport(report, 'html').body;

    for (const expected of [
      'Operational clarity',
      'Learning capacity',
      '2 / 7',
      '6 / 7',
      'turn-support-1',
      'A concrete participant claim.',
      'A concrete counter claim.',
      'A concrete example is missing.',
      'Hinweis zur KI-generierten Konfidenz',
      'modellgenerierte Selbsteinschätzungen',
      'keine statistisch kalibrierten Wahrscheinlichkeiten oder Konfidenzintervalle',
      'Fördernde Evidenz',
      'Hemmende Evidenz',
    ]) {
      expect(markdown).toContain(expected);
      expect(html).toContain(expected);
    }
    expect(markdown).toContain('Kein Score');
    expect(html).toContain('Kein Score');
    expect(html).toContain('Verwendeter Anker 2');
    expect(html).toContain('=FORMULA item criterion 2');
    expect(html).toContain('@media print');
    expect(html).toContain('overflow-wrap: anywhere');
  });

  it('escapes untrusted profile and transcript text in Markdown and HTML', () => {
    const report = fixture();
    report.dimensions[0]!.items[0]!.rationale = '<script>alert("x")</script>';
    const reparsed = profileEvaluationReportSchema.parse(report);

    const markdown = exportEvaluationReport(reparsed, 'markdown').body;
    const html = exportEvaluationReport(reparsed, 'html').body;
    expect(markdown).not.toContain('<script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('localizes all English export formats without changing canonical evidence', () => {
    const report = fixture('en');
    const json = exportEvaluationReport(report, 'json').body;
    const csv = exportEvaluationReport(report, 'csv').body;
    const markdown = exportEvaluationReport(report, 'markdown').body;
    const html = exportEvaluationReport(report, 'html').body;

    expect(JSON.parse(json)).toEqual(report);
    expect(csv).toContain('"language"');
    expect(csv).toContain('"en"');
    expect(csv).toContain('"Scored"');
    expect(markdown).toContain('# Evaluation report: Generic evaluation profile');
    expect(markdown).toContain('## Methodology');
    expect(markdown).toContain('### Limitations');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Supporting evidence');
    expect(html).toContain('Profile translation');
    for (const artifact of [csv, markdown, html]) {
      expect(artifact).toContain('model-generated self-assessments');
      expect(artifact).toContain(
        'not statistically calibrated probabilities or confidence intervals',
      );
    }
    for (const artifact of [json, csv, markdown, html]) {
      expect(artifact).toContain('A concrete participant claim.');
    }
    expect(markdown).not.toContain('Auswertungsreport');
    expect(html).not.toContain('Fördernde Evidenz');
  });

  it.each(['de', 'en'] as const)(
    'preserves multiple direct and indirect evidence entries and every source in %s exports',
    (language) => {
      const report = classifiedFixture(language);
      const json = exportEvaluationReport(report, 'json').body;
      const csv = exportEvaluationReport(report, 'csv').body;
      const markdown = exportEvaluationReport(report, 'markdown').body;
      const html = exportEvaluationReport(report, 'html').body;

      expect(JSON.parse(json)).toEqual(genericReport(report));
      expect(JSON.parse(json).schemaVersion).toBe(5);
      for (const artifact of [json, csv, markdown, html]) {
        expect(artifact).not.toContain('evidenceType');
        expect(artifact).not.toContain('ambiguousEvidence');
        expect(artifact).not.toContain('ambiguous_evidence_json');
        expect(artifact).not.toContain('Mehrdeutige Evidenz');
        expect(artifact).not.toContain('Ambiguous evidence');
      }
      for (const item of report.dimensions.flatMap((dimension) => dimension.items)) {
        for (const bucket of [item.supportingEvidence, item.counterEvidence]) {
          const genericBucket = bucket.map(({ evidenceType, ...entry }) => {
            void evidenceType;
            return entry;
          });
          expect(csv).toContain(`"${JSON.stringify(genericBucket).replaceAll('"', '""')}"`);
          for (const reference of bucket) {
            for (const source of [reference, ...(reference.additionalSources ?? [])]) {
              for (const artifact of [json, csv, markdown, html]) {
                expect(artifact).toContain(source.turnId);
                expect(artifact).toContain(source.verbatimExcerpt);
              }
              expect(markdown).toContain(`Turn ${String(source.sequenceNumber)} (`);
              expect(html).toContain(`Turn ${String(source.sequenceNumber)} | `);
            }
            if (reference.inference) {
              for (const artifact of [json, csv, markdown, html]) {
                expect(artifact).toContain(reference.inference);
              }
            }
          }
        }
      }
      const labels =
        language === 'de'
          ? ['Fördernde Evidenz', 'Hemmende Evidenz', 'Evidenz', 'Ableitung', 'Weitere Quelle']
          : [
              'Supporting evidence',
              'Counter evidence',
              'Evidence',
              'Inference',
              'Additional source',
            ];
      for (const label of labels) {
        expect(markdown).toContain(label);
        expect(html).toContain(label);
      }
      expect(markdown).toContain('2 / 7');
      expect(html).toContain('6 / 7');
    },
  );

  it('includes a legacy evidence notice once per export without changing the evidence', () => {
    const report = classifiedFixture();
    report.legacyEvidenceNotice =
      'This original report contains unassigned evidence preserved in storage and not reclassified.';
    const reparsed = profileEvaluationReportSchema.parse(report);

    for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
      const artifact = exportEvaluationReport(reparsed, format).body;
      expect(artifact.split(report.legacyEvidenceNotice)).toHaveLength(2);
      expect(artifact).toContain('turn-support-3');
      expect(artifact).toContain('turn-counter-4');
      expect(artifact).toContain('turn-source-4');
    }
    expect(JSON.parse(exportEvaluationReport(reparsed, 'json').body)).toEqual(
      genericReport(reparsed),
    );
    const csv = exportEvaluationReport(reparsed, 'csv').body;
    expect(csv.split('\r\n')).toHaveLength(5);
    expect(csv).toContain('"legacy_evidence_notice"');
    expect(exportEvaluationReport(classifiedFixture(), 'html').body).not.toContain(
      'class="legacy-evidence-notice"',
    );
  });

  it('escapes legacy notices in human-readable exports and neutralizes CSV formulas', () => {
    const report = fixture();
    report.legacyEvidenceNotice = '=NOTICE <script>alert("legacy")</script>';
    const reparsed = profileEvaluationReportSchema.parse(report);

    for (const format of ['markdown', 'html'] as const) {
      const artifact = exportEvaluationReport(reparsed, format).body;
      expect(artifact).not.toContain('<script>');
      expect(artifact).toContain('&lt;script&gt;');
    }
    expect(exportEvaluationReport(reparsed, 'csv').body).toContain('"\'=NOTICE ');
  });

  it('keeps a single supporting quote single and leaves empty counter evidence empty', () => {
    const report = classifiedFixture();
    for (const dimension of report.dimensions) {
      for (const item of dimension.items) item.counterEvidence = [];
    }
    const first = report.dimensions[0]!.items[0]!;
    expect(first.supportingEvidence).toHaveLength(1);

    for (const format of ['json', 'csv', 'markdown', 'html'] as const) {
      const artifact = exportEvaluationReport(report, format).body;
      expect(artifact.split('turn-support-1')).toHaveLength(2);
      expect(artifact).not.toContain('turn-counter-3');
    }
    expect(exportEvaluationReport(report, 'markdown').body).not.toContain('**Hemmende Evidenz:**');
    expect(exportEvaluationReport(report, 'html').body).not.toContain('<h4>Hemmende Evidenz</h4>');
  });

  it.each(['de', 'en'] as const)(
    'labels legacy evidence as unclassified in %s without inventing metadata',
    (language) => {
      const report = fixture(language);
      const json = exportEvaluationReport(report, 'json').body;
      const csv = exportEvaluationReport(report, 'csv').body;
      const markdown = exportEvaluationReport(report, 'markdown').body;
      const html = exportEvaluationReport(report, 'html').body;
      const label = language === 'de' ? 'Evidenz' : 'Evidence';

      expect(JSON.parse(json)).toEqual(report);
      for (const artifact of [json, csv]) {
        expect(artifact).not.toContain('evidenceType');
        expect(artifact).not.toContain('inference');
      }
      for (const artifact of [markdown, html]) {
        expect(artifact).toContain(label);
        expect(artifact).not.toContain('Indirekte Evidenz');
        expect(artifact).not.toContain('Indirect evidence');
      }
    },
  );

  it('escapes inference text and additional source quotations in human-readable exports', () => {
    const report = classifiedFixture();
    const reference = report.dimensions[1]!.items[0]!.supportingEvidence[0]!;
    reference.inference = '<script>alert("inference")</script>';
    reference.additionalSources![0]!.verbatimExcerpt = '<img src=x onerror="alert(1)">';
    const reparsed = profileEvaluationReportSchema.parse(report);

    for (const format of ['markdown', 'html'] as const) {
      const artifact = exportEvaluationReport(reparsed, format).body;
      expect(artifact).not.toContain('<script>');
      expect(artifact).not.toContain('<img src=x');
      expect(artifact).toContain('&lt;script&gt;');
      expect(artifact).toContain('&lt;img src=x');
    }
    expect(JSON.parse(exportEvaluationReport(reparsed, 'json').body)).toEqual(
      genericReport(reparsed),
    );
  });
});

function recalculate(report: EvaluationReport): EvaluationReport {
  const scores = new Map(
    report.dimensions.flatMap((dimension) =>
      dimension.items.map((item) => [item.itemId, item.score] as const),
    ),
  );
  const calculated = calculateProfileScores(report.profile, scores);
  report.calculation = calculated.calculation;
  report.overallAggregate = calculated.overallAggregate;
  for (const [index, dimension] of report.dimensions.entries()) {
    dimension.weight = report.profile.dimensions[index]!.weight;
    dimension.aggregate = calculated.dimensions[index]!.aggregate;
    for (const item of dimension.items) {
      item.weight = report.profile.items.find(({ itemId }) => itemId === item.itemId)!.weight;
    }
  }
  return profileEvaluationReportSchema.parse(report);
}

function genericReport(report: EvaluationReport): unknown {
  return JSON.parse(
    JSON.stringify(report, (key, value: unknown) => (key === 'evidenceType' ? undefined : value)),
  );
}

function classifiedFixture(language: 'de' | 'en' = 'de'): EvaluationReport {
  const report = fixture(language);
  report.dimensions[0]!.items[0]!.supportingEvidence = [
    {
      ...evidence('turn-support-1', 2, 'A concrete participant claim.'),
      evidenceType: 'direct',
      inference: null,
      additionalSources: [],
    },
  ];
  const item = report.dimensions[1]!.items[0]!;
  item.supportingEvidence = [
    {
      ...evidence('turn-support-3', 5, 'The shift lead changed the schedule.'),
      evidenceType: 'indirect',
      inference: 'The described local decision suggests delegated authority.',
      additionalSources: [
        evidence('turn-source-3', 7, 'No approval from management was required.'),
      ],
    },
    {
      ...evidence('turn-support-4', 8, 'We documented the change for the next shift.'),
      evidenceType: 'indirect',
      inference: 'Sharing the documented change suggests a learning practice.',
      additionalSources: [],
    },
  ];
  item.counterEvidence = [
    {
      ...evidence('turn-counter-3', 6, 'A concrete counter claim.'),
      evidenceType: 'direct',
      inference: null,
      additionalSources: [],
    },
    {
      ...evidence('turn-counter-4', 9, 'The other site never received that note.'),
      evidenceType: 'indirect',
      inference: 'The missing transfer suggests that learning was limited to one site.',
      additionalSources: [
        evidence('turn-source-4', 10, 'They repeated the same mistake the next week.'),
      ],
    },
  ];
  return profileEvaluationReportSchema.parse(report);
}

function fixture(language: 'de' | 'en' = 'de'): EvaluationReport {
  const profileItems = [
    profileItem('clarity-1', 'clarity', '=FORMULA item', 0),
    profileItem('clarity-2', 'clarity', 'Decision transparency', 1),
    profileItem('learning-1', 'learning', 'Learning routines', 0),
  ];
  const profile = {
    profileId: 'profile-export',
    name: 'Generic evaluation profile',
    description: 'Arbitrary dimensions and items.',
    coderPrompt: 'Evaluate only observed evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [
      { dimensionId: 'clarity', name: 'Operational clarity', order: 0 },
      { dimensionId: 'learning', name: 'Learning capacity', order: 1 },
    ],
    items: profileItems,
  };
  const first = {
    ...profileItems[0],
    status: 'scored',
    score: 2,
    appliedAnchor: profileItems[0]!.anchors[1],
    confidence: 0.78,
    supportingEvidence: [evidence('turn-support-1', 2, 'A concrete participant claim.')],
    counterEvidence: [],
    missingInformation: [],
    rationale: 'Observed evidence matches the second anchor.',
  };
  const second = {
    ...profileItems[1],
    status: 'insufficient_evidence',
    score: null,
    appliedAnchor: null,
    confidence: 0.2,
    supportingEvidence: [],
    counterEvidence: [],
    missingInformation: ['A concrete example is missing.'],
    rationale: 'No numeric value is assigned without evidence.',
  };
  const third = {
    ...profileItems[2],
    status: 'scored',
    score: 6,
    appliedAnchor: profileItems[2]!.anchors[5],
    confidence: 0.74,
    supportingEvidence: [evidence('turn-support-3', 5, 'A concrete learning practice.')],
    counterEvidence: [evidence('turn-counter-3', 6, 'A concrete counter claim.')],
    missingInformation: [],
    rationale: 'Supporting and counter evidence best match anchor six.',
  };
  return profileEvaluationReportSchema.parse({
    schemaVersion: 5,
    reportKind: 'evaluation_profile_report',
    evaluationId: 'evaluation-export',
    interviewId: 'interview-export',
    profileId: profile.profileId,
    profileName: profile.name,
    profileUpdatedAt: '2026-08-21T15:00:00.000Z',
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
    model: { mode: 'demo', provider: null, model: null },
    profile,
    calculation: calculateProfileScores(profile, {
      'clarity-1': 2,
      'clarity-2': null,
      'learning-1': 6,
    }).calculation,
    dimensions: [
      {
        ...profile.dimensions[0],
        aggregate: {
          status: 'partial',
          score: 2,
          scoredItemCount: 1,
          unscoredItemCount: 1,
          totalItemCount: 2,
        },
        items: [first, second],
      },
      {
        ...profile.dimensions[1],
        aggregate: {
          status: 'complete',
          score: 6,
          scoredItemCount: 1,
          unscoredItemCount: 0,
          totalItemCount: 1,
        },
        items: [third],
      },
    ],
    overallAggregate: {
      status: 'partial',
      score: 4,
      scoredItemCount: 2,
      unscoredItemCount: 1,
      totalItemCount: 3,
    },
    rationale: 'Two items are scored and one remains explicitly unscored.',
    evaluatedAt: '2026-08-21T15:01:00.000Z',
  });
}

function profileItem(itemId: string, dimensionId: string, name: string, order: number) {
  return {
    itemId,
    dimensionId,
    name,
    codingInstruction: `Evaluate ${name} from exact participant evidence.`,
    order,
    anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
      score,
      criterion: `${name} criterion ${String(score)}`,
    })),
  };
}

function evidence(turnId: string, sequenceNumber: number, verbatimExcerpt: string) {
  return { turnId, sequenceNumber, verbatimExcerpt };
}
