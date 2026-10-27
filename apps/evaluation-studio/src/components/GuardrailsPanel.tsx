import type { EvaluationProfileLockedGuardrails } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Check, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

const GUARDRAIL_LABELS: ReadonlyArray<{
  readonly key: keyof EvaluationProfileLockedGuardrails;
  readonly label: string;
  readonly detail: string;
  readonly englishLabel: string;
  readonly englishDetail: string;
}> = [
  {
    key: 'evidenceSource',
    label: 'Evidenzquelle',
    detail: 'Nur finale Teilnehmer-Turns dürfen als Evidenz dienen.',
    englishLabel: 'Evidence source',
    englishDetail: 'Only final participant turns may be used as evidence.',
  },
  {
    key: 'exactQuotesRequired',
    label: 'Wortgetreue Zitate',
    detail: 'Jedes Zitat muss exakt im referenzierten Turn vorkommen.',
    englishLabel: 'Verbatim quotations',
    englishDetail: 'Every quotation must appear exactly in the referenced turn.',
  },
  {
    key: 'validTurnReferencesRequired',
    label: 'Gültige Turn-Referenzen',
    detail: 'Turn-ID und Sequenznummer werden serverseitig geprüft.',
    englishLabel: 'Valid turn references',
    englishDetail: 'Turn IDs and sequence numbers are checked on the server.',
  },
  {
    key: 'fabricatedContentForbidden',
    label: 'Keine Ergänzungen',
    detail: 'Nicht beobachtete Inhalte dürfen nicht erfunden werden.',
    englishLabel: 'No fabricated content',
    englishDetail: 'Unobserved content must not be invented.',
  },
  {
    key: 'hiddenChainOfThoughtForbidden',
    label: 'Keine verborgenen Modellgedanken',
    detail: 'Nur explizite, evidenzbasierte und auditierbare Begründungen sind zulässig.',
    englishLabel: 'No hidden model reasoning',
    englishDetail: 'Only explicit, evidence-based and auditable rationales are permitted.',
  },
  {
    key: 'structuredOutputLocked',
    label: 'Gesperrtes Ausgabeschema',
    detail: 'Die Ergebnisstruktur kann nicht durch Profiltexte verändert werden.',
    englishLabel: 'Locked output schema',
    englishDetail: 'Profile text cannot change the result structure.',
  },
  {
    key: 'scoreRangeLocked',
    label: 'Scorebereich 1 bis 7',
    detail: 'Erlaubt sind Integer-Scores 1 bis 7 oder explizite Non-Score-Zustände.',
    englishLabel: 'Score range 1 to 7',
    englishDetail: 'Allowed values are integer scores from 1 to 7 or explicit non-score states.',
  },
  {
    key: 'aggregationLocked',
    label: 'Deterministische Aggregation',
    detail: 'Dimensionen und Gesamtwert werden außerhalb des Modells berechnet.',
    englishLabel: 'Deterministic aggregation',
    englishDetail: 'Dimension scores and the overall score are calculated outside the model.',
  },
];

export function GuardrailsPanel({
  guardrails,
  loading,
  error,
  onRetry,
}: {
  readonly guardrails: EvaluationProfileLockedGuardrails | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}): ReactNode {
  const { locale } = useI18n();
  const english = locale === 'en';
  return (
    <section className="guardrails-panel" aria-labelledby="guardrails-title">
      <header>
        <span className="guardrail-icon" aria-hidden="true">
          <ShieldCheck size={18} />
        </span>
        <div>
          <span className="eyebrow">Read-only</span>
          <h2 id="guardrails-title">
            {english ? 'Locked system guardrails' : 'Gesperrte System-Guardrails'}
          </h2>
          <p>
            {english
              ? 'These rules apply to every profile and cannot be overridden by its content.'
              : 'Diese Regeln gelten für jedes Profil und können fachlich nicht überschrieben werden.'}
          </p>
        </div>
        <LockKeyhole aria-label={english ? 'Not editable' : 'Nicht editierbar'} size={17} />
      </header>

      {loading && guardrails === null ? (
        <p className="guardrail-state">{english ? 'Loading rules.' : 'Regeln werden geladen.'}</p>
      ) : null}
      {error === null ? null : (
        <div className="guardrail-state is-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            {english ? 'Retry' : 'Erneut laden'}
          </button>
        </div>
      )}
      {guardrails === null ? null : (
        <dl className="guardrail-list">
          {GUARDRAIL_LABELS.map((entry) => (
            <div key={entry.key}>
              <dt>
                <Check aria-hidden="true" size={13} />
                {english ? entry.englishLabel : entry.label}
              </dt>
              <dd>{english ? entry.englishDetail : entry.detail}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
