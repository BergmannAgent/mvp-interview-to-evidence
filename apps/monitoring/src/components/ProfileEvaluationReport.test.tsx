import {
  calculateProfileScores,
  PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
  profileEvaluationReportSchema,
  profileEvaluationSnapshotSchema,
  type EvaluationProfilePortable,
  type ProfileEvaluationReport,
  type ProfileEvaluationReportItem,
} from '@orgscience/contracts';
import { LocaleProvider, type SupportedLocale } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EvaluationPanel } from './EvaluationPanel.js';
import { ProfileEvaluationReport as ProfileEvaluationReportView } from './ProfileEvaluationReport.js';

describe('ProfileEvaluationReport', () => {
  it('renders detailed multiline item and report rationales without truncation', () => {
    const candidate = report();
    const rationale =
      'The participant described a bounded decision practice. '.repeat(20) +
      '\n\nA broader scope is not established.';
    firstReportItem(candidate).rationale = rationale;
    candidate.rationale = rationale;
    const original = structuredClone(candidate);
    const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />);
    expect(rationale.length).toBeGreaterThan(800);
    expect(html).toContain(rationale);
    expect(candidate).toEqual(original);
  });
  it.each(['de', 'en'] as const)(
    'renders participant metadata and source links in %s',
    (language) => {
      const data = report();
      data.participantDetails = {
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
      const html = renderLocalized(<ProfileEvaluationReportView report={data} />, language);
      expect(html).toContain('war Bereichsleiterin');
      expect(html).toContain('Ich war Bereichsleiterin.');
      expect(html).toContain('href="#turn-participant-details"');
      expect(html).toContain(
        language === 'de' ? 'Nicht angegeben oder nicht eindeutig' : 'Not stated or unclear',
      );
    },
  );

  it('does not invent participant details in historical reports', () => {
    const html = renderLocalized(<ProfileEvaluationReportView report={report()} />);
    expect(html).toContain('Nicht erfasst');
  });
  it('renders arbitrary dimensions, all intermediate scores, explicit non-scores, and evidence', () => {
    const html = renderLocalized(<ProfileEvaluationReportView report={report()} />);

    expect(html).toContain('Cross-functional collaboration profile');
    expect(html).toContain('Servicequalität');
    expect(html).toContain('Wissensfluss');
    expect(html).toContain('Abstimmungsqualität');
    expect(html).toContain('title="2 von 7"');
    expect(html).toContain('title="3 von 7"');
    expect(html).toContain('title="5 von 7"');
    expect(html).toContain('title="6 von 7"');
    expect(html).toContain('Unzureichende Evidenz');
    expect(html).toContain('Nicht anwendbar');
    expect(html).toContain('Widersprüchliche Evidenz');
    expect(html).toContain('Kein Score');
    expect(html).toContain('Angewendeter Anker');
    expect(html).toContain('Anchor criterion 5 for service-3');
    expect(html).toContain('Fördernde Evidenz');
    expect(html).toContain('Hemmende Evidenz');
    expect(html).toContain('Hinweis zur KI-generierten Konfidenz');
    expect(html).toContain(
      'keine statistisch kalibrierten Wahrscheinlichkeiten oder Konfidenzintervalle',
    );
    expect(html).toContain('KI-Selbsteinschätzung, keine statistisch validierte Sicherheit.');
    expect(html).not.toContain('Mehrdeutige Evidenz');
    expect(html).toContain('href="#turn-turn-supporting-1"');
    expect(html).toContain('<code title="turn-supporting-1">turn-supporting-1</code>');
    expect(html).toContain('The teams review incidents every Friday.');
    expect(html).toContain('A concrete handover example is missing.');
    expect(html).toContain('4 / 7');
    expect(html).toContain('3 ohne numerischen Score');
    expect(html).not.toContain('Robustness');
    expect(html).not.toContain('Agility');
    expect(html).not.toContain('Integrity');
  });

  it('keeps monitoring read-only while exporting the exact selected profile report', () => {
    const evaluation = profileEvaluationSnapshotSchema.parse({
      status: 'completed',
      evaluationId: 'evaluation-custom-ui',
      interviewId: 'interview-custom-ui',
      profileId: 'profile-custom-ui',
      profileFingerprint: 'a'.repeat(64),
      startedAt: '2026-08-21T12:59:00.000Z',
      completedAt: '2026-08-21T13:00:00.000Z',
      report: report(),
      failure: null,
    });
    const html = renderLocalized(
      <EvaluationPanel
        interviewId="interview-custom-ui"
        evaluation={evaluation}
        loading={false}
        error={null}
        onReload={() => undefined}
      />,
    );

    expect(html).toContain('Auswertungsreport');
    expect(html).toContain('evaluation/export?format=html&amp;profileId=profile-custom-ui');
    expect(html).toContain('Druckansicht');
    expect(html).not.toContain('Erneut versuchen');
    expect(html).not.toContain('Wiederaufnehmen');
    expect(html).not.toContain('Auswertung starten');
  });

  it('does not present an absent aggregate as zero or score one', () => {
    const candidate = structuredClone(report());
    const items = candidate.dimensions.flatMap((dimension) => dimension.items);
    for (const item of items) {
      item.status = 'insufficient_evidence';
      item.score = null;
      item.appliedAnchor = null;
      item.confidence = 0;
      item.supportingEvidence = [];
      item.counterEvidence = [];
      item.missingInformation = ['No sufficient evidence.'];
      item.rationale = 'The item cannot be scored from the available evidence.';
    }
    for (const dimension of candidate.dimensions) {
      dimension.aggregate = aggregate(0, dimension.items.length, null);
    }
    candidate.overallAggregate = aggregate(0, items.length, null);
    candidate.calculation = calculateProfileScores(
      candidate.profile,
      new Map(items.map((item) => [item.itemId, item.score])),
    ).calculation;
    const parsed = profileEvaluationReportSchema.parse(candidate);

    const html = renderLocalized(<ProfileEvaluationReportView report={parsed} />);
    expect(html).toContain('Gesamtwert</small><strong>Nicht bewertet</strong>');
    expect(html).not.toContain('Gesamtwert</small><strong>0</strong>');
  });

  it('renders English monitoring chrome without translating canonical evidence', () => {
    const html = renderLocalized(<ProfileEvaluationReportView report={report()} />, 'en');

    expect(html).toContain('Overall score');
    expect(html).toContain('AI-generated confidence disclaimer');
    expect(html).toContain('not statistically calibrated probabilities or confidence intervals');
    expect(html).toContain('AI self-assessment, not statistically validated certainty.');
    expect(html).toContain('Supporting evidence');
    expect(html).toContain('Applied anchor');
    expect(html).toContain('The teams review incidents every Friday.');
    expect(html).not.toContain('Gesamtwert');
    expect(html).not.toContain('Ambiguous evidence');
  });

  it('keeps legacy evidence explicitly unclassified', () => {
    const html = renderLocalized(<ProfileEvaluationReportView report={report()} />);

    expect(html).toContain('>Evidenz</span>');
    expect(html).not.toContain('profile-evidence-type is-direct');
    expect(html).not.toContain('profile-evidence-type is-indirect');
    expect(html).not.toContain('profile-legacy-evidence-notice');
  });

  it.each(['de', 'en'] as const)(
    'renders a collapsed read-only weighted calculation audit in %s',
    (locale) => {
      const profile = portableProfile();
      profile.dimensions[0]!.weight = 3;
      profile.dimensions[1]!.weight = 0;
      profile.items[0]!.weight = 2;
      profile.items[1]!.weight = 0;
      const candidate = report(profile);
      const original = structuredClone(candidate);
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);

      expect(html).toContain('<details class="profile-calculation-details">');
      expect(html).not.toContain('<details class="profile-calculation-details" open="">');
      expect(html).toContain(locale === 'de' ? 'Berechnungsnachweis' : 'Calculation audit');
      expect(html).toContain(locale === 'de' ? 'Gewichtetes Mittel' : 'Weighted mean');
      expect(html).toContain(locale === 'de' ? 'Dimensionsgewichte' : 'Dimension weights');
      expect(html).toContain(locale === 'de' ? 'Itemgewichte' : 'Item weights');
      expect(html).toContain(locale === 'de' ? 'Effektives Gewicht' : 'Effective weight');
      expect(html).toContain(locale === 'de' ? 'Einbezogen' : 'Included');
      expect(html).toContain(
        locale === 'de' ? 'Fehlender Score; ausgeschlossen' : 'Missing score; excluded',
      );
      expect(html).toContain(
        locale === 'de' ? 'Nullgewicht; kein Beitrag' : 'Zero weight; no contribution',
      );
      expect(html).toContain(
        '<code>service-1</code></th><td><code>service</code></td><td>2</td><td>2</td><td>3</td><td>6</td>',
      );
      expect(html).toContain(locale === 'de' ? 'Gewichteter Beitrag' : 'Weighted contribution');
      expect(html).toContain('<td>6</td><td>12</td><td>');
      expect(html).toContain(
        `<dt>${locale === 'de' ? 'Gewichtete Summe' : 'Weighted sum'}</dt><dd>45</dd>`,
      );
      expect(html).toContain(
        `<dt>${locale === 'de' ? 'Gewichtssumme' : 'Weight sum'}</dt><dd>12</dd>`,
      );
      expect(html).not.toContain('profile-calculation-error');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('<button');
      expect(candidate).toEqual(original);
    },
  );

  it.each(['de', 'en'] as const)(
    'renders actual formula references and zero substitutions without weighted exclusions in %s',
    (locale) => {
      const profile = portableProfile();
      profile.dimensions[0]!.weight = 0;
      profile.items[1]!.weight = 0;
      profile.calculation = {
        mode: 'formula',
        expression:
          'item("service-2") + item("knowledge-1") + dimension("knowledge") + itemWeight("service-2") + dimensionWeight("service")',
      };
      const candidate = report(profile);
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);

      expect(html).toContain(locale === 'de' ? 'Formel' : 'Formula');
      expect(html).toContain(locale === 'de' ? 'Ausdruck' : 'Expression');
      expect(html).toContain(locale === 'de' ? 'Ausgewertete Referenzen' : 'Evaluated references');
      expect(html).toContain('<code>item(&quot;service-2&quot;)</code></th><td>3</td>');
      expect(html).toContain('<code>item(&quot;knowledge-1&quot;)</code></th><td>0</td>');
      expect(html).toContain('<code>dimension(&quot;knowledge&quot;)</code></th><td>0</td>');
      expect(html).toContain('<code>itemWeight(&quot;service-2&quot;)</code></th><td>0</td>');
      expect(html).toContain('<code>dimensionWeight(&quot;service&quot;)</code></th><td>0</td>');
      expect(
        html.match(
          locale === 'de' ? /Fehlender Wert durch 0 ersetzt/gu : /Missing value replaced by 0/gu,
        ),
      ).toHaveLength(2);
      expect(html).toContain(
        locale === 'de' ? 'Effektives Mittelwertgewicht' : 'Effective mean weight',
      );
      expect(html).not.toContain(locale === 'de' ? 'Beitrag zum Mittelwert' : 'Mean contribution');
      expect(html).not.toContain(locale === 'de' ? 'ausgeschlossen' : 'excluded');
      expect(html).not.toContain(locale === 'de' ? 'kein Beitrag' : 'no contribution');
    },
  );

  it.each([
    ['de', -13.5, '-13,5'],
    ['en', -13.5, '-13.5'],
    ['de', 125, '125'],
    ['en', 125, '125'],
  ] as const)(
    'renders custom overall %s result %s without a seven-point scale',
    (locale, score, formatted) => {
      const profile = portableProfile();
      profile.calculation = { mode: 'formula', expression: String(score) };
      const html = renderLocalized(
        <ProfileEvaluationReportView report={report(profile)} />,
        locale,
      );
      const resultLabel = locale === 'de' ? 'Formelergebnis' : 'Formula result';

      expect(html).toContain(
        `<strong>${formatted}</strong><span title="${resultLabel}">${resultLabel}</span>`,
      );
      expect(html).toContain(
        `<span class="profile-score" title="${formatted} (${resultLabel})">${formatted}</span>`,
      );
      expect(html).not.toContain(`title="${formatted} ${locale === 'de' ? 'von' : 'out of'} 7"`);
      expect(html).toContain(
        `<span class="profile-score" title="4 ${locale === 'de' ? 'von' : 'out of'} 7">4<small class="profile-score-scale">/7</small></span>`,
      );
      expect(html).toContain(
        `<span class="profile-score" title="2 ${locale === 'de' ? 'von' : 'out of'} 7">2<small class="profile-score-scale">/7</small></span>`,
      );
    },
  );

  it.each(['de', 'en'] as const)(
    'keeps large finite formula scores compact in both headline displays in %s',
    (locale) => {
      for (const score of [1e9, -1e9, 1e308, -1e308]) {
        const profile = portableProfile();
        profile.calculation = { mode: 'formula', expression: String(score) };
        const candidate = report(profile);
        const original = structuredClone(candidate);
        const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);
        const formatted = new Intl.NumberFormat(locale, {
          maximumFractionDigits: 2,
          notation: 'scientific',
        }).format(score);
        const summaryScore = html.match(
          /class="profile-report-summary"[\s\S]*?<strong>([^<]*)<\/strong>/u,
        )?.[1];
        const headingScore = html.match(/class="profile-score"[^>]*>([^<]*)<\/span>/u)?.[1];

        expect(candidate.overallAggregate.score).toBe(score);
        expect(summaryScore).toBe(formatted);
        expect(headingScore).toBe(formatted);
        expect(formatted.length).toBeLessThan(12);
        expect(headingScore).not.toContain('/7');
        expect(html).toContain('<small class="profile-score-scale">/7</small>');
        expect(candidate).toEqual(original);
      }
    },
  );

  it.each(['de', 'en'] as const)(
    'keeps calculation errors visible outside collapsed audit details in %s',
    (locale) => {
      const profile = portableProfile();
      profile.calculation = { mode: 'formula', expression: '1 / item("knowledge-1")' };
      const candidate = report(profile);
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);
      const error = html.indexOf('<p class="profile-calculation-error" role="alert">');
      const details = html.indexOf('<details class="profile-calculation-details">');

      expect(candidate.calculation.status).toBe('error');
      expect(error).toBeGreaterThan(-1);
      expect(details).toBeGreaterThan(error);
      expect(html).toContain(
        locale === 'de' ? 'Berechnung fehlgeschlagen.' : 'Calculation failed.',
      );
      expect(html).toContain(
        locale === 'de'
          ? 'Division oder Restwertbildung durch null ist nicht definiert.'
          : 'Division or remainder by zero is undefined.',
      );
      expect(html).toContain('<code>division_by_zero</code></p><details');
      expect(html).toContain('<code>item(&quot;knowledge-1&quot;)</code></th><td>0</td>');
      expect(html).not.toContain('Gesamtwert</small><strong>0</strong>');
      expect(html).not.toContain('Overall score</small><strong>0</strong>');
    },
  );

  it('does not invent an audit for a legacy runtime report without a trace', () => {
    const candidate = report();
    const { calculation, ...legacy } = candidate;
    const html = renderLocalized(
      <ProfileEvaluationReportView report={legacy as ProfileEvaluationReport} />,
    );
    expect(html).not.toContain('profile-calculation');
    expect(html).toContain('title="4 von 7"');
    expect(calculation.mode).toBe('weighted_mean');
  });

  it('does not present a zero-weight overall as numeric zero', () => {
    const profile = portableProfile();
    for (const dimension of profile.dimensions) dimension.weight = 0;
    const html = renderLocalized(<ProfileEvaluationReportView report={report(profile)} />);

    expect(html).toContain('Gesamtwert</small><strong>Nicht bewertet</strong>');
    expect(html).toContain('Nullgewicht; kein Beitrag');
    expect(html).toContain('title="4 von 7"');
    expect(html).not.toContain('Gesamtwert</small><strong>0</strong>');
  });

  it('renders unavailable effective weights and an exposed error after numeric overflow', () => {
    const profile = portableProfile();
    profile.dimensions[0]!.weight = 1e308;
    profile.items[0]!.weight = 2;
    const candidate = report(profile);
    const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, 'en');

    expect(candidate.calculation.items[0]?.effectiveWeight).toBeNull();
    expect(html).toContain('Calculation failed.');
    expect(html).toContain('The calculation produced a non-finite value.');
    expect(html).not.toContain('Infinity');
    expect(html).not.toContain('NaN');
  });

  it.each(['de', 'en'] as const)(
    'renders a historical report notice once without altering evidence in %s',
    (locale) => {
      const candidate = report();
      candidate.legacyEvidenceNotice =
        locale === 'de'
          ? 'Historische Evidenz ist im archivierten Originalbericht erhalten.'
          : 'Historical evidence is preserved in the archived original report.';
      const original = structuredClone(candidate);
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);

      expect(html.match(/profile-legacy-evidence-notice/gu)).toHaveLength(1);
      expect(html).toContain(candidate.legacyEvidenceNotice);
      expect(html).toContain('The teams review incidents every Friday.');
      expect(html).toContain('Some teams do not share their findings.');
      expect(html).not.toContain('profile-evidence-type is-direct');
      expect(html).not.toContain('profile-evidence-type is-indirect');
      expect(html).not.toContain('Mehrdeutige Evidenz');
      expect(html).not.toContain('Ambiguous evidence');
      expect(candidate).toEqual(original);
    },
  );

  it.each(['direct', 'indirect'] as const)(
    'renders a single %s evidence without inventing another',
    (evidenceType) => {
      const candidate = report();
      const item = firstReportItem(candidate);
      item.supportingEvidence = [
        {
          turnId: 'singleton-source',
          sequenceNumber: 2,
          verbatimExcerpt: 'Die Schichtleitung entschied selbst.',
          evidenceType,
          inference:
            evidenceType === 'indirect' ? 'Dies deutet auf delegierte Befugnisse hin.' : null,
        },
      ];
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />);

      expect(html.match(/href="#turn-singleton-source"/gu)).toHaveLength(1);
      expect(html).toContain('>Evidenz</span>');
      expect(html).not.toContain('>Direkt</span>');
      expect(html).not.toContain('>Indirekt</span>');
      expect(html).toContain('<blockquote>Die Schichtleitung entschied selbst.</blockquote>');
      if (evidenceType === 'indirect') {
        expect(html).toContain(
          '<strong>Ableitung: </strong>Dies deutet auf delegierte Befugnisse hin.',
        );
      } else {
        expect(html).not.toContain('profile-evidence-inference');
      }
    },
  );

  it.each(['de', 'en'] as const)(
    'renders mixed evidence and all linked sources in %s',
    (locale) => {
      const candidate = report();
      const item = firstReportItem(candidate);
      item.supportingEvidence = [
        { ...evidence('supporting', 12), evidenceType: 'direct' },
        {
          ...evidence('supporting', 13),
          evidenceType: 'indirect',
          inference: '<script>Die Aussagen deuten auf eigenständige Entscheidungen hin.</script>',
          additionalSources: [
            {
              turnId: 'context-source-1',
              sequenceNumber: 14,
              verbatimExcerpt: 'Keine Freigabe war erforderlich.',
            },
            {
              turnId: 'context-source-2',
              sequenceNumber: 15,
              verbatimExcerpt: 'Dies gilt für alle Schichten.',
            },
          ],
        },
      ];
      item.counterEvidence = [
        { ...evidence('counter', 16), evidenceType: 'direct' },
        {
          ...evidence('counter', 17),
          evidenceType: 'indirect',
          inference: 'Es besteht eine Grenze der Befugnisse.',
          additionalSources: [
            {
              turnId: 'counter-context-source',
              sequenceNumber: 18,
              verbatimExcerpt: 'Ohne Freigabe blieb die Investition gesperrt.',
            },
          ],
        },
      ];
      const html = renderLocalized(<ProfileEvaluationReportView report={candidate} />, locale);

      for (const source of [
        'turn-supporting-12',
        'turn-supporting-13',
        'context-source-1',
        'context-source-2',
        'turn-counter-16',
        'turn-counter-17',
        'counter-context-source',
      ]) {
        expect(html.match(new RegExp(`href="#turn-${source}"`, 'gu'))).toHaveLength(1);
      }
      expect(html).toContain(locale === 'de' ? '>Evidenz</span>' : '>Evidence</span>');
      expect(html).not.toMatch(
        />(Direkt|Indirekt|Direct|Indirect|Unclassified|Nicht klassifiziert)<\/span>/u,
      );
      expect(html).toContain(
        locale === 'de' ? '<strong>Ableitung: </strong>' : '<strong>Inference: </strong>',
      );
      expect(html).toContain('<blockquote>Dies gilt für alle Schichten.</blockquote>');
      expect(html).toContain(
        '<blockquote>Ohne Freigabe blieb die Investition gesperrt.</blockquote>',
      );
      expect(html).toContain('Es besteht eine Grenze der Befugnisse.');
      expect(html.match(/profile-evidence-inference/gu)).toHaveLength(2);
      expect(html.match(/profile-evidence-list tone-/gu)).toHaveLength(14);
      expect(html).toContain(locale === 'de' ? 'Fördernde Evidenz' : 'Supporting evidence');
      expect(html).toContain(locale === 'de' ? 'Hemmende Evidenz' : 'Counter-evidence');
      expect(html).not.toContain('Mehrdeutige Evidenz');
      expect(html).not.toContain('Ambiguous evidence');
      expect(html).not.toContain('tone-ambiguous');
      expect(html).toContain(
        '&lt;script&gt;Die Aussagen deuten auf eigenständige Entscheidungen hin.&lt;/script&gt;',
      );
      expect(html).not.toContain('<script>');
    },
  );
});

function firstReportItem(candidate: ProfileEvaluationReport): ProfileEvaluationReportItem {
  const item = candidate.dimensions[0]?.items[0];
  if (item === undefined) throw new Error('Expected an item in the test report');
  return item;
}

function renderLocalized(node: ReactNode, locale: SupportedLocale = 'de'): string {
  return renderToStaticMarkup(
    <LocaleProvider fallbackLocale={locale} storageKey={`monitoring-test-${locale}`}>
      {node}
    </LocaleProvider>,
  );
}

function report(profile = portableProfile()): ProfileEvaluationReport {
  const items = profile.items.map((item, index) => {
    const statuses = [
      scoredItem(item, 2, 1),
      scoredItem(item, 3, 2),
      scoredItem(item, 5, 3),
      scoredItem(item, 6, 4),
      insufficientItem(item),
      notApplicableItem(item),
      conflictingItem(item),
    ];
    return statuses[index]!;
  });
  const serviceItems = items.slice(0, 4);
  const knowledgeItems = items.slice(4);
  const calculated = calculateProfileScores(
    profile,
    new Map(items.map((item) => [item.itemId, item.score])),
  );

  return profileEvaluationReportSchema.parse({
    schemaVersion: PROFILE_EVALUATION_REPORT_SCHEMA_VERSION,
    reportKind: 'evaluation_profile_report',
    evaluationId: 'evaluation-custom-ui',
    interviewId: 'interview-custom-ui',
    profileId: profile.profileId,
    profileName: profile.name,
    profileUpdatedAt: '2026-08-21T12:30:00.000Z',
    profileFingerprint: 'a'.repeat(64),
    transcriptFingerprint: 'b'.repeat(64),
    promptVersion: 'profile-evidence-coding-v1',
    model: { mode: 'provider', provider: 'openai', model: 'fast-evaluation-model' },
    profile,
    dimensions: [
      {
        ...profile.dimensions[0],
        aggregate: calculated.dimensions[0]!.aggregate,
        items: serviceItems,
      },
      {
        ...profile.dimensions[1],
        aggregate: calculated.dimensions[1]!.aggregate,
        items: knowledgeItems,
      },
    ],
    overallAggregate: calculated.overallAggregate,
    calculation: calculated.calculation,
    rationale: 'The report preserves observed evidence and explicit non-score states.',
    evaluatedAt: '2026-08-21T13:00:00.000Z',
  });
}

function portableProfile(): EvaluationProfilePortable {
  const dimensions = [
    { dimensionId: 'service', name: 'Servicequalität', order: 0 },
    { dimensionId: 'knowledge', name: 'Wissensfluss', order: 1 },
  ];
  const specifications = [
    ['service-1', 'service', 'Abstimmungsqualität', 0],
    ['service-2', 'service', 'Entscheidungstempo', 1],
    ['service-3', 'service', 'Fehlerbearbeitung', 2],
    ['service-4', 'service', 'Kundenorientierung', 3],
    ['knowledge-1', 'knowledge', 'Übergaben', 0],
    ['knowledge-2', 'knowledge', 'Dokumentation', 1],
    ['knowledge-3', 'knowledge', 'Lernschleifen', 2],
  ] as const;
  return {
    profileId: 'profile-custom-ui',
    name: 'Cross-functional collaboration profile',
    description: 'A deliberately guide-independent test profile.',
    coderPrompt: 'Evaluate every item using only observed participant evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions,
    items: specifications.map(([itemId, dimensionId, name, order]) => ({
      itemId,
      dimensionId,
      name,
      codingInstruction: `Evaluate ${name}.`,
      order,
      anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
        score,
        criterion: `Anchor criterion ${String(score)} for ${itemId}`,
      })) as EvaluationProfilePortable['items'][number]['anchors'],
    })),
  };
}

function scoredItem(
  item: EvaluationProfilePortable['items'][number],
  score: 2 | 3 | 5 | 6,
  sequenceNumber: number,
): ProfileEvaluationReportItem {
  return {
    ...item,
    status: 'scored',
    score,
    appliedAnchor: item.anchors[score - 1]!,
    confidence: 0.82,
    supportingEvidence: [evidence('supporting', sequenceNumber)],
    counterEvidence: [],
    missingInformation: [],
    rationale: `Observed evidence matches score ${String(score)}.`,
  };
}

function insufficientItem(
  item: EvaluationProfilePortable['items'][number],
): ProfileEvaluationReportItem {
  return {
    ...item,
    status: 'insufficient_evidence',
    score: null,
    appliedAnchor: null,
    confidence: 0.2,
    supportingEvidence: [],
    counterEvidence: [],
    missingInformation: ['A concrete handover example is missing.'],
    rationale: 'The transcript does not support a numeric score.',
  };
}

function notApplicableItem(
  item: EvaluationProfilePortable['items'][number],
): ProfileEvaluationReportItem {
  return {
    ...item,
    status: 'not_applicable',
    score: null,
    appliedAnchor: null,
    confidence: 0.65,
    supportingEvidence: [],
    counterEvidence: [],
    missingInformation: [],
    rationale: 'The item does not apply to the described operating model.',
  };
}

function conflictingItem(
  item: EvaluationProfilePortable['items'][number],
): ProfileEvaluationReportItem {
  return {
    ...item,
    status: 'conflicting',
    score: null,
    appliedAnchor: null,
    confidence: 0.4,
    supportingEvidence: [evidence('supporting', 5)],
    counterEvidence: [evidence('counter', 6)],
    missingInformation: [],
    rationale: 'Observed statements point in different directions.',
  };
}

function evidence(kind: 'supporting' | 'counter', sequenceNumber: number) {
  return {
    turnId: `turn-${kind}-${String(sequenceNumber)}`,
    sequenceNumber,
    verbatimExcerpt:
      kind === 'supporting'
        ? 'The teams review incidents every Friday.'
        : 'Some teams do not share their findings.',
  };
}

function aggregate(scoredItemCount: number, totalItemCount: number, score: number | null) {
  const unscoredItemCount = totalItemCount - scoredItemCount;
  return {
    status:
      scoredItemCount === 0
        ? ('not_scored' as const)
        : unscoredItemCount === 0
          ? ('complete' as const)
          : ('partial' as const),
    score,
    scoredItemCount,
    unscoredItemCount,
    totalItemCount,
  };
}
