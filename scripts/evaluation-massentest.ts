import { createHash } from 'node:crypto';

import {
  evaluationProfileDocumentSchema,
  evaluationProfileListResponseSchema,
  evaluationProfileResponseSchema,
  idSchema,
  type EvaluationProfile,
  type EvaluationProfileDocument,
  type MvpInterviewSession,
  type ProfileEvaluationReport,
  type ProfileEvaluationReportItem,
} from '../packages/contracts/src/index.js';
import {
  PROFILE_EVALUATION_CODING_PROMPT_VERSION,
  type EvaluationCoder,
} from '../apps/backend/src/application/evaluations/evaluation-coder.js';
import { validateEvaluationTranscript } from '../apps/backend/src/application/evaluations/evaluation-guardrails.js';
import { exportEvaluationReport } from '../apps/backend/src/application/evaluations/evaluation-report-export.js';
import { buildProfileEvaluationReport } from '../apps/backend/src/application/evaluations/profile-evaluation-report.js';

export const MASSENTEST_RUN_COUNT = 10;

export interface MassentestInputs {
  readonly profile: EvaluationProfile;
  readonly profileDocument: EvaluationProfileDocument;
  readonly session: MvpInterviewSession;
  readonly profileFingerprint: string;
  readonly transcriptFingerprint: string;
}

interface RunMetadata {
  readonly index: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly providerCalls: number;
}

export type MassentestRun = RunMetadata &
  (
    | { readonly status: 'completed'; readonly report: ProfileEvaluationReport }
    | {
        readonly status: 'failed';
        readonly failure: { readonly code: string; readonly message: string };
      }
  );

export interface MassentestRunnerOptions {
  readonly batchId: string;
  readonly coder: EvaluationCoder;
  readonly providerCalls: () => number;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly onRun?: (run: MassentestRun) => Promise<void> | void;
}

/** Reads the user's saved default once; never imports, creates, or evaluates database records. */
export async function readDefaultMassentestProfile(
  backendUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<EvaluationProfile> {
  const base = new URL(backendUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Backend URL must use HTTP or HTTPS.');
  }
  const list = evaluationProfileListResponseSchema.parse(
    await readApiJson(new URL('/api/v1/evaluation-profiles', base), fetcher),
  );
  const defaults = list.profiles.filter((profile) => profile.isDefault);
  const selected = defaults[0];
  if (defaults.length !== 1 || selected === undefined) {
    throw new Error('Exactly one saved default evaluation profile is required.');
  }
  const response = evaluationProfileResponseSchema.parse(
    await readApiJson(
      new URL(`/api/v1/evaluation-profiles/${encodeURIComponent(selected.profileId)}`, base),
      fetcher,
    ),
  );
  if (!response.profile.isDefault || response.profile.profileId !== selected.profileId) {
    throw new Error('The saved default profile changed while being loaded.');
  }
  return response.profile;
}

async function readApiJson(url: URL, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(`Default profile read failed (HTTP ${String(response.status)}).`);
  return response.json() as Promise<unknown>;
}

export function prepareMassentestInputs(
  profile: EvaluationProfile,
  sessionCandidate: unknown,
): MassentestInputs {
  const { profileId, name, description, coderPrompt, scale, dimensions, items } = profile;
  const profileDocument = evaluationProfileDocumentSchema.parse({
    schemaVersion: 1,
    profile: { profileId, name, description, coderPrompt, scale, dimensions, items },
  });
  const validated = validateEvaluationTranscript(sessionCandidate);
  if (!validated.ok) {
    throw new Error(`Synthetic transcript is invalid (${validated.issues[0]?.code ?? 'unknown'}).`);
  }
  return {
    profile: structuredClone(profile),
    profileDocument,
    session: validated.value,
    profileFingerprint: massentestFingerprint(profileDocument),
    transcriptFingerprint: massentestFingerprint(validated.value),
  };
}

export function massentestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/** Ten evaluation slots, not ten claims of success: failed slots are never silently replaced. */
export async function runEvaluationMassentest(
  inputs: MassentestInputs,
  options: MassentestRunnerOptions,
): Promise<readonly MassentestRun[]> {
  idSchema.parse(options.batchId);
  const now = options.now ?? (() => new Date());
  const runs: MassentestRun[] = [];
  for (let index = 1; index <= MASSENTEST_RUN_COUNT; index += 1) {
    const runId = `${options.batchId}-run-${String(index).padStart(2, '0')}`;
    const started = now();
    const callsBefore = options.providerCalls();
    let outcome:
      | Pick<Extract<MassentestRun, { status: 'completed' }>, 'status' | 'report'>
      | Pick<Extract<MassentestRun, { status: 'failed' }>, 'status' | 'failure'>;
    try {
      const result = await options.coder.code(
        {
          profile: structuredClone(inputs.profileDocument),
          session: structuredClone(inputs.session),
        },
        { runId, signal: options.signal },
      );
      if (!result.ok) {
        outcome = {
          status: 'failed',
          failure: { code: result.error.code, message: result.error.message },
        };
      } else {
        outcome = {
          status: 'completed',
          report: buildProfileEvaluationReport(inputs.profile, inputs.session, result.output, {
            evaluationId: runId,
            interviewId: inputs.session.interviewId,
            profileFingerprint: inputs.profileFingerprint,
            transcriptFingerprint: inputs.transcriptFingerprint,
            language: inputs.session.language ?? 'de',
            profileTranslation: null,
            promptVersion: PROFILE_EVALUATION_CODING_PROMPT_VERSION,
            model: options.coder.model,
            evaluatedAt: now().toISOString(),
          }),
        };
      }
    } catch {
      outcome = {
        status: 'failed',
        failure: {
          code: 'run_rejected',
          message: 'Evaluation failed execution or deterministic report validation.',
        },
      };
    }
    const ended = now();
    const run: MassentestRun = {
      index,
      runId,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      durationMs: Math.max(0, ended.getTime() - started.getTime()),
      providerCalls: options.providerCalls() - callsBefore,
      ...outcome,
    };
    runs.push(run);
    await options.onRun?.(run);
  }
  return runs;
}

export function massentestRunMarkdown(run: MassentestRun): string {
  const header = [
    `# Massentest: Durchlauf ${String(run.index)}`,
    '',
    `- Run-ID: \`${run.runId}\``,
    `- Status: ${run.status}`,
    `- Beginn: ${run.startedAt}`,
    `- Ende: ${run.endedAt}`,
    `- Laufzeit: ${String(run.durationMs)} ms`,
    `- Echte Modellaufrufe einschließlich Reparatur: ${String(run.providerCalls)}`,
    '',
    '> Vollständig synthetischer Testfall; kein empirischer Befund.',
    '',
  ].join('\n');
  if (run.status === 'completed') {
    return `${header}${exportEvaluationReport(run.report, 'markdown').body}`;
  }
  return `${header}## Fehler\n\n- Code: \`${run.failure.code}\`\n- Meldung: ${run.failure.message}\n\nDieser Durchlauf wurde nicht durch eine zusätzliche Auswertung ersetzt.\n`;
}

export function massentestInputMarkdown(inputs: MassentestInputs): string {
  const lines = [
    '# Massentest: Eingangstranskript',
    '',
    '> Vollstaendig synthetisches Interview. Die folgenden Turntexte entsprechen unveraendert der JSON-Eingabe.',
    '',
    `- Interview-ID: \`${inputs.session.interviewId}\``,
    `- Leitfaden: ${inputs.session.guideTitle}`,
    `- Transkript-Fingerprint: \`${inputs.transcriptFingerprint}\``,
    '',
  ];
  for (const turn of inputs.session.transcript) {
    lines.push(
      `## ${String(turn.sequenceNumber)} - ${turn.speaker} - ${turn.occurredAt}`,
      '',
      turn.text,
      '',
    );
  }
  return lines.join('\n');
}

export interface MassentestItemComparison {
  readonly itemId: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly scoredCount: number;
  readonly mean: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly standardDeviation: number | null;
  readonly modalValues: readonly string[];
  readonly modalCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly evidenceChoicesStable: boolean;
  readonly rationaleTextsStable: boolean;
}

export interface MassentestComparison {
  readonly attemptedRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly providerCalls: number;
  readonly distinctScoreVectors: number;
  readonly exactScoreAgreement: boolean;
  readonly items: readonly MassentestItemComparison[];
  readonly overallScores: readonly (number | null)[];
}

export function compareMassentestRuns(
  profile: EvaluationProfile,
  runs: readonly MassentestRun[],
): MassentestComparison {
  const completed = runs.filter((run) => run.status === 'completed');
  const itemMaps = completed.map(
    (run) => new Map(reportItems(run.report).map((item) => [item.itemId, item])),
  );
  const vectors = completed.map((run) =>
    JSON.stringify(reportItems(run.report).map((item) => [item.itemId, item.status, item.score])),
  );
  const distinctScoreVectors = new Set(vectors).size;
  const items = profile.items.map((profileItem): MassentestItemComparison => {
    const scored = itemMaps.flatMap((map) => {
      const score = map.get(profileItem.itemId)?.score;
      return score == null ? [] : [score];
    });
    const results = itemMaps.flatMap((map) => {
      const item = map.get(profileItem.itemId);
      return item === undefined ? [] : [item];
    });
    const statusCounts: Record<string, number> = {};
    for (const item of results) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    const valueCounts = new Map<string, number>();
    for (const item of results) {
      const value = item.score === null ? item.status : String(item.score);
      valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
    }
    const modalCount = Math.max(0, ...valueCounts.values());
    const average = scored.length === 0 ? null : mean(scored);
    return {
      itemId: profileItem.itemId,
      name: profileItem.name,
      values: runs.map((run) => {
        if (run.status === 'failed') return 'RUN_FAILED';
        const item = reportItems(run.report).find(
          (candidate) => candidate.itemId === profileItem.itemId,
        );
        return item?.score == null ? (item?.status ?? 'MISSING_ITEM') : String(item.score);
      }),
      scoredCount: scored.length,
      mean: average === null ? null : round(average),
      minimum: scored.length === 0 ? null : Math.min(...scored),
      maximum: scored.length === 0 ? null : Math.max(...scored),
      standardDeviation:
        average === null
          ? null
          : round(Math.sqrt(mean(scored.map((score) => (score - average) ** 2)))),
      modalValues: [...valueCounts]
        .filter(([, count]) => count === modalCount)
        .map(([value]) => value)
        .toSorted(),
      modalCount,
      statusCounts,
      evidenceChoicesStable:
        results.length > 0 && new Set(results.map(evidenceSignature)).size === 1,
      rationaleTextsStable:
        results.length > 0 && new Set(results.map(rationaleSignature)).size === 1,
    };
  });
  return {
    attemptedRuns: runs.length,
    completedRuns: completed.length,
    failedRuns: runs.length - completed.length,
    providerCalls: runs.reduce((sum, run) => sum + run.providerCalls, 0),
    distinctScoreVectors,
    exactScoreAgreement:
      runs.length === MASSENTEST_RUN_COUNT &&
      completed.length === MASSENTEST_RUN_COUNT &&
      distinctScoreVectors === 1,
    items,
    overallScores: runs.map((run) =>
      run.status === 'completed' ? run.report.overallAggregate.score : null,
    ),
  };
}

function reportItems(report: ProfileEvaluationReport): ProfileEvaluationReportItem[] {
  return report.dimensions.flatMap((dimension) => dimension.items);
}

function evidenceSignature(item: ProfileEvaluationReportItem): string {
  const signature = (direction: 'supportingEvidence' | 'counterEvidence') =>
    item[direction]
      .map((evidence) =>
        canonicalJson({
          direction,
          turnId: evidence.turnId,
          sequenceNumber: evidence.sequenceNumber,
          quote: evidence.verbatimExcerpt,
          additionalSources: (evidence.additionalSources ?? [])
            .map((source) => canonicalJson(source))
            .toSorted(),
        }),
      )
      .toSorted();
  return JSON.stringify([...signature('supportingEvidence'), ...signature('counterEvidence')]);
}

function rationaleSignature(item: ProfileEvaluationReportItem): string {
  return canonicalJson({
    rationale: item.rationale,
    missingInformation: item.missingInformation,
    inferences: [...item.supportingEvidence, ...item.counterEvidence]
      .map((evidence) => ({
        turnId: evidence.turnId,
        quote: evidence.verbatimExcerpt,
        inference: evidence.inference,
      }))
      .toSorted((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  });
}

export function massentestComparisonMarkdown(
  inputs: MassentestInputs,
  runs: readonly MassentestRun[],
): string {
  const comparison = compareMassentestRuns(inputs.profile, runs);
  const cells = (values: readonly unknown[]) =>
    `| ${values
      .map((value) =>
        String(value ?? '—')
          .replaceAll('|', '\\|')
          .replaceAll('\n', ' '),
      )
      .join(' | ')} |`;
  const lines = [
    '# Massentest: Stabilitätsvergleich',
    '',
    '> Ein synthetischer Fall, zehn unabhängige Auswertungen. Dieser Test prüft Wiederholbarkeit, nicht wissenschaftliche Validität.',
    '',
    `- Profil: ${inputs.profile.name} (\`${inputs.profile.profileId}\`, gespeichert ${inputs.profile.updatedAt})`,
    `- Profil-Fingerprint: \`${inputs.profileFingerprint}\``,
    `- Transkript-Fingerprint: \`${inputs.transcriptFingerprint}\``,
    `- Modell: ${runs.find((run) => run.status === 'completed')?.report.model.model ?? 'siehe manifest.json'}`,
    `- Prompt-Version: ${PROFILE_EVALUATION_CODING_PROMPT_VERSION}`,
    `- Auswertungsdurchläufe: ${String(comparison.attemptedRuns)}; erfolgreich ${String(comparison.completedRuns)}; fehlgeschlagen ${String(comparison.failedRuns)}`,
    `- Tatsächliche Modellaufrufe: ${String(comparison.providerCalls)} (ein Reparaturaufruf pro Durchlauf möglich)`,
    `- Unterschiedliche Item-/Status-Vektoren: ${String(comparison.distinctScoreVectors)}`,
    '',
    '## Ergebnis',
    '',
    comparison.exactScoreAgreement
      ? 'Alle zehn Auswertungen lieferten denselben Item-/Status-Vektor. Begründungen und Evidenzauswahl können dennoch variieren.'
      : comparison.failedRuns > 0
        ? 'Mindestens eine Auswertung ist fehlgeschlagen. Eine vollständige 10/10-Stabilität kann nicht behauptet werden; erfolgreiche Durchläufe werden unten verglichen.'
        : 'Die Itemwerte oder Non-Score-Status unterscheiden sich zwischen den Auswertungen; identische Gesamtmittel allein würden diese Abweichungen nicht ausschließen.',
    '',
    '## Gesamtergebnisse pro Durchlauf',
    '',
    cells([
      'Lauf',
      'Status',
      'Gesamtwert',
      'Bewertete Items',
      'Non-Scores',
      'Modellaufrufe',
      'Laufzeit ms',
    ]),
    cells(['---', '---', '---', '---', '---', '---', '---']),
    ...runs.map((run) =>
      cells([
        run.index,
        run.status,
        run.status === 'completed' ? run.report.overallAggregate.score : null,
        run.status === 'completed' ? run.report.overallAggregate.scoredItemCount : null,
        run.status === 'completed' ? run.report.overallAggregate.unscoredItemCount : null,
        run.providerCalls,
        run.durationMs,
      ]),
    ),
    '',
    '## Itemwerte',
    '',
    cells([
      'Item',
      ...runs.map((run) => `L${String(run.index)}`),
      'n',
      'Mittel',
      'Min',
      'Max',
      'SD',
      'Haeufigster Wert/Status',
      'Haeufigkeit',
    ]),
    cells(Array.from({ length: runs.length + 8 }, () => '---')),
    ...comparison.items.map((item) =>
      cells([
        item.itemId,
        ...item.values,
        item.scoredCount,
        item.mean,
        item.minimum,
        item.maximum,
        item.standardDeviation,
        item.modalValues.join(', '),
        item.modalCount,
      ]),
    ),
    '',
    '## Evidenz und Begründung',
    '',
    cells([
      'Item',
      'Bezeichnung',
      'Statusverteilung',
      'Gleiche Quellen/Richtung/Evidenztypen',
      'Gleiche Begründungstexte',
    ]),
    cells(['---', '---', '---', '---', '---']),
    ...comparison.items.map((item) =>
      cells([
        item.itemId,
        item.name,
        JSON.stringify(item.statusCounts),
        item.evidenceChoicesStable ? 'ja' : 'nein',
        item.rationaleTextsStable ? 'ja' : 'nein',
      ]),
    ),
    '',
    '## Interpretation und Grenzen',
    '',
    '- Die Zielspanne 4–5 beschreibt nur die Konstruktion des Falls und wurde nicht an den Coder übergeben. Tatsächliche Scores werden nie angepasst.',
    '- Gesamtwerte entsprechen der bestehenden Pipeline: arithmetisches Mittel aller bewerteten Items, nicht Mittel der Dimensionsmittel. Non-Scores und fehlgeschlagene Runs sind niemals 0.',
    '- Itemmittel und Populationsstandardabweichung (SD) verwenden nur numerische Scores erfolgreicher Runs. Anzahl n und Statusverteilung gehören zur Interpretation; n=1 erlaubt keine Stabilitätsaussage.',
    '- Der haeufigste Wert/Status und seine Haeufigkeit verwenden erfolgreiche Itemergebnisse einschliesslich Non-Scores. Gleichstaende werden vollstaendig gezeigt; fehlgeschlagene Runs zaehlen nicht als Itemstatus.',
    '- Verglichen werden vollständige Item-/Status-Vektoren, nicht nur Gesamtmittel. Evidenzvergleich erfasst Zitate, Quellen, direkte/indirekte Kennzeichnung und Richtung; Textvergleich ist getrennt davon.',
    '- Die Modellaufrufzahl enthält Reparaturen der bestehenden Pipeline. Ein reparierter Output ist ein Ergebnis desselben Durchlaufs, keine elfte unabhängige Auswertung.',
    '- Profil und Transkript wurden vor dem ersten Aufruf eingefroren. Ergebnisse wurden weder in Eval Studio noch in der produktiven Datenbank gespeichert.',
    '- Wiederholbarkeit eines Falls beweist weder Validität des Instruments noch Generalisierbarkeit auf andere Interviews.',
    '',
  ];
  return lines.join('\n');
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
