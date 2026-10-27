import {
  calculateProfileScores,
  PROFILE_CALCULATION_LIMITS,
  resolveProfileCalculation,
  type EvaluationProfileContent,
} from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Calculator, Plus, RotateCcw, Sigma } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { firstError, updateCalculation, type DraftValidation } from '../profile-draft.js';
import { profileUiError } from './profile-ui-errors.js';
import './CalculationEditor.css';

const COPY = {
  de: {
    aggregate: 'Aggregat',
    title: 'Berechnung',
    mode: 'Berechnungsmodus',
    weighted: 'Gewichtetes Mittel',
    formula: 'Formel',
    expression: 'Formelausdruck',
    referenceFunction: 'Referenzfunktion',
    reference: 'Referenz',
    insert: 'Referenz einfügen',
    item: 'Itemwert',
    dimension: 'Dimensionswert',
    itemWeight: 'Itemgewicht',
    dimensionWeight: 'Dimensionsgewicht',
    effectiveWeight: 'Effektives Gewicht',
    weightProduct: 'Dimensionsgewicht * Itemgewicht',
    zeroWeight: 'Gewicht 0',
    zeroContribution: 'Kein Beitrag zum Mittelwert',
    missing: 'Fehlende Werte',
    weightedMissing: 'Vom Mittelwert ausgeschlossen',
    formulaMissing: 'In Formeln als 0 eingesetzt',
    resultScale: 'Ergebnisskala',
    unrestricted: 'Nicht begrenzt',
    scoreScale: '1 bis 7',
    preview: 'Lokale Testvorschau',
    testScore: 'Testwert',
    missingValue: 'Fehlend',
    reset: 'Testwerte zurücksetzen',
    result: 'Gesamtergebnis',
    dimensionResult: 'Dimensionsresultat',
    noResult: 'Nicht berechnet',
    invalidDraft: 'Keine Vorschau für ein ungültiges Profil.',
    invalidTestScore: 'Testwerte müssen ganze Zahlen von 1 bis 7 sein oder leer bleiben.',
    weightInvalid: 'Das Gewicht muss eine endliche Zahl größer oder gleich 0 sein.',
    weight: 'Gewicht',
  },
  en: {
    aggregate: 'Aggregate',
    title: 'Calculation',
    mode: 'Calculation mode',
    weighted: 'Weighted mean',
    formula: 'Formula',
    expression: 'Formula expression',
    referenceFunction: 'Reference function',
    reference: 'Reference',
    insert: 'Insert reference',
    item: 'Item score',
    dimension: 'Dimension score',
    itemWeight: 'Item weight',
    dimensionWeight: 'Dimension weight',
    effectiveWeight: 'Effective weight',
    weightProduct: 'Dimension weight * item weight',
    zeroWeight: 'Weight 0',
    zeroContribution: 'No contribution to the mean',
    missing: 'Missing scores',
    weightedMissing: 'Excluded from the mean',
    formulaMissing: 'Substituted with 0 in formulas',
    resultScale: 'Result scale',
    unrestricted: 'Unbounded',
    scoreScale: '1 to 7',
    preview: 'Local test preview',
    testScore: 'Test score',
    missingValue: 'Missing',
    reset: 'Reset test scores',
    result: 'Overall result',
    dimensionResult: 'Dimension result',
    noResult: 'Not calculated',
    invalidDraft: 'Preview unavailable for an invalid profile.',
    invalidTestScore: 'Test scores must be integers from 1 to 7 or left empty.',
    weightInvalid: 'The weight must be a finite number greater than or equal to 0.',
    weight: 'Weight',
  },
} as const;

export type FormulaReferenceFunction = 'item' | 'dimension' | 'itemWeight' | 'dimensionWeight';

export function insertFormulaReference(
  expression: string,
  referenceFunction: FormulaReferenceFunction,
  id: string,
  selectionStart: number,
  selectionEnd: number,
): { readonly expression: string; readonly cursor: number } {
  const start = Math.max(0, Math.min(expression.length, selectionStart));
  const end = Math.max(start, Math.min(expression.length, selectionEnd));
  const reference = `${referenceFunction}(${JSON.stringify(id)})`;
  return {
    expression: expression.slice(0, start) + reference + expression.slice(end),
    cursor: start + reference.length,
  };
}

export function previewScores(
  content: EvaluationProfileContent,
  values: Readonly<Record<string, string>>,
): ReadonlyMap<string, number | null> | null {
  const scores = new Map<string, number | null>();
  for (const item of content.items) {
    const raw = Object.hasOwn(values, item.itemId) ? (values[item.itemId]?.trim() ?? '') : '';
    if (raw === '') {
      scores.set(item.itemId, null);
      continue;
    }
    const score = Number(raw);
    if (!Number.isInteger(score) || score < 1 || score > 7) return null;
    scores.set(item.itemId, score);
  }
  return scores;
}

export function CalculationEditor({
  content,
  validation,
  disabled,
  onChange,
}: {
  readonly content: EvaluationProfileContent;
  readonly validation: DraftValidation;
  readonly disabled: boolean;
  readonly onChange: (content: EvaluationProfileContent) => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const calculation = resolveProfileCalculation(content);
  const expression = calculation.mode === 'formula' ? calculation.expression : '';
  const [savedExpression, setSavedExpression] = useState(expression);
  const [referenceFunction, setReferenceFunction] = useState<FormulaReferenceFunction>('item');
  const [referenceId, setReferenceId] = useState('');
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const expressionInput = useRef<HTMLTextAreaElement>(null);
  const expressionError = firstError(validation, 'calculation.expression', 'calculation');
  const references =
    referenceFunction === 'dimension' || referenceFunction === 'dimensionWeight'
      ? content.dimensions.map((dimension) => ({
          id: dimension.dimensionId,
          name: dimension.name,
        }))
      : content.items.map((item) => ({ id: item.itemId, name: item.name }));
  const selectedReference = references.some(({ id }) => id === referenceId)
    ? referenceId
    : (references[0]?.id ?? '');
  const scores = previewScores(content, values);
  const preview =
    validation.valid && scores !== null ? calculateProfileScores(content, scores) : null;
  const previewError = !validation.valid
    ? copy.invalidDraft
    : scores === null
      ? copy.invalidTestScore
      : preview?.calculation.error === null || preview?.calculation.error === undefined
        ? null
        : profileUiError(preview.calculation.error.message, locale);

  const changeExpression = (next: string): void => {
    setSavedExpression(next);
    onChange(updateCalculation(content, { mode: 'formula', expression: next }));
  };
  const insertReference = (): void => {
    if (selectedReference === '') return;
    const input = expressionInput.current;
    const inserted = insertFormulaReference(
      expression,
      referenceFunction,
      selectedReference,
      input?.selectionStart ?? expression.length,
      input?.selectionEnd ?? expression.length,
    );
    changeExpression(inserted.expression);
    requestAnimationFrame(() => {
      expressionInput.current?.focus();
      expressionInput.current?.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  };

  return (
    <section className="calculation-section" aria-labelledby="profile-calculation-title">
      <header className="section-heading">
        <div>
          <span className="eyebrow">{copy.aggregate}</span>
          <h2 id="profile-calculation-title">{copy.title}</h2>
        </div>
      </header>
      <div className="calculation-mode" role="group" aria-label={copy.mode}>
        <button
          type="button"
          aria-pressed={calculation.mode === 'weighted_mean'}
          disabled={disabled}
          onClick={() => {
            if (calculation.mode === 'weighted_mean') return;
            if (calculation.mode === 'formula') setSavedExpression(calculation.expression);
            onChange(updateCalculation(content, { mode: 'weighted_mean' }));
          }}
        >
          <Sigma aria-hidden="true" size={15} />
          {copy.weighted}
        </button>
        <button
          type="button"
          aria-pressed={calculation.mode === 'formula'}
          disabled={disabled}
          onClick={() => {
            if (calculation.mode === 'formula') return;
            onChange(updateCalculation(content, { mode: 'formula', expression: savedExpression }));
          }}
        >
          <Calculator aria-hidden="true" size={15} />
          {copy.formula}
        </button>
      </div>

      {calculation.mode === 'formula' ? (
        <div className="formula-editor">
          <label className="field is-mono" htmlFor="profile-calculation-expression">
            <span className="field-label">
              <strong>{copy.expression}</strong>
              <small>
                {expression.length} / {PROFILE_CALCULATION_LIMITS.maximumExpressionLength}
              </small>
            </span>
            <textarea
              id="profile-calculation-expression"
              ref={expressionInput}
              value={expression}
              rows={4}
              maxLength={PROFILE_CALCULATION_LIMITS.maximumExpressionLength}
              disabled={disabled}
              spellCheck={false}
              aria-invalid={expressionError === null ? undefined : true}
              aria-describedby={
                expressionError === null ? undefined : 'calculation-expression-error'
              }
              onChange={(event) => changeExpression(event.target.value)}
            />
            {expressionError === null ? null : (
              <small className="field-error" id="calculation-expression-error" role="alert">
                {profileUiError(expressionError, locale)}
              </small>
            )}
          </label>
          <div className="formula-reference-toolbar">
            <label className="field" htmlFor="formula-reference-function">
              <span className="field-label">
                <strong>{copy.referenceFunction}</strong>
              </span>
              <select
                id="formula-reference-function"
                value={referenceFunction}
                disabled={disabled}
                onChange={(event) =>
                  setReferenceFunction(event.target.value as FormulaReferenceFunction)
                }
              >
                <option value="item">item() · {copy.item}</option>
                <option value="dimension">dimension() · {copy.dimension}</option>
                <option value="itemWeight">itemWeight() · {copy.itemWeight}</option>
                <option value="dimensionWeight">dimensionWeight() · {copy.dimensionWeight}</option>
              </select>
            </label>
            <label className="field" htmlFor="formula-reference-id">
              <span className="field-label">
                <strong>{copy.reference}</strong>
              </span>
              <select
                id="formula-reference-id"
                value={selectedReference}
                disabled={disabled || references.length === 0}
                onChange={(event) => setReferenceId(event.target.value)}
              >
                {references.map((reference, index) => (
                  <option key={`${String(index)}:${reference.id}`} value={reference.id}>
                    {reference.name} ({reference.id})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon-button"
              title={copy.insert}
              aria-label={copy.insert}
              disabled={disabled || selectedReference === ''}
              onClick={insertReference}
            >
              <Plus aria-hidden="true" size={17} />
            </button>
          </div>
        </div>
      ) : null}

      <dl className="calculation-policies">
        <div>
          <dt>{copy.effectiveWeight}</dt>
          <dd>{copy.weightProduct}</dd>
        </div>
        <div>
          <dt>{copy.zeroWeight}</dt>
          <dd>{copy.zeroContribution}</dd>
        </div>
        <div>
          <dt>{copy.missing}</dt>
          <dd>{calculation.mode === 'formula' ? copy.formulaMissing : copy.weightedMissing}</dd>
        </div>
        <div>
          <dt>{copy.resultScale}</dt>
          <dd>{calculation.mode === 'formula' ? copy.unrestricted : copy.scoreScale}</dd>
        </div>
      </dl>

      <details className="calculation-preview" open>
        <summary>{copy.preview}</summary>
        <div className="calculation-preview-header">
          <output
            aria-live="polite"
            aria-describedby={previewError === null ? undefined : 'calculation-preview-error'}
          >
            <span>{copy.result}</span>
            <strong>
              {formatResult(preview?.overallAggregate.score ?? null, locale, copy.noResult)}
            </strong>
          </output>
          <button
            className="icon-button"
            type="button"
            title={copy.reset}
            aria-label={copy.reset}
            disabled={disabled || Object.keys(values).length === 0}
            onClick={() => setValues({})}
          >
            <RotateCcw aria-hidden="true" size={15} />
          </button>
        </div>
        {previewError === null ? null : (
          <p className="field-error" id="calculation-preview-error" role="alert">
            {previewError}
          </p>
        )}
        <div className="calculation-preview-values">
          {content.dimensions.map((dimension, dimensionIndex) => (
            <section key={dimensionIndex} aria-label={dimension.name || dimension.dimensionId}>
              <header>
                <strong>{dimension.name || dimension.dimensionId}</strong>
                <span>
                  {copy.dimensionResult}:{' '}
                  {formatResult(
                    preview?.dimensions.find(
                      ({ dimensionId }) => dimensionId === dimension.dimensionId,
                    )?.aggregate.score ?? null,
                    locale,
                    copy.noResult,
                  )}
                </span>
              </header>
              {content.items
                .filter((item) => item.dimensionId === dimension.dimensionId)
                .map((item, itemIndex) => {
                  const raw = Object.hasOwn(values, item.itemId) ? (values[item.itemId] ?? '') : '';
                  const invalid =
                    raw.trim() !== '' &&
                    (!Number.isInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 7);
                  return (
                    <div className="calculation-preview-row" key={itemIndex}>
                      <label
                        htmlFor={`calculation-test-${String(dimensionIndex)}-${String(itemIndex)}`}
                      >
                        <span>{item.name || item.itemId}</span>
                        <code>{item.itemId}</code>
                      </label>
                      <span className="preview-effective-weight" title={copy.effectiveWeight}>
                        {copy.weight}:{' '}
                        {formatWeight(
                          (dimension.weight ?? 1) * (item.weight ?? 1),
                          locale,
                          copy.noResult,
                        )}
                      </span>
                      <input
                        id={`calculation-test-${String(dimensionIndex)}-${String(itemIndex)}`}
                        type="number"
                        min={1}
                        max={7}
                        step={1}
                        value={raw}
                        placeholder={copy.missingValue}
                        aria-label={`${copy.testScore}: ${item.name || item.itemId}`}
                        aria-invalid={invalid ? true : undefined}
                        aria-describedby={invalid ? 'calculation-preview-error' : undefined}
                        disabled={disabled}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [item.itemId]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  );
                })}
            </section>
          ))}
        </div>
      </details>
    </section>
  );
}

export function WeightField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number | undefined;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onChange: (weight: number) => void;
}): ReactNode {
  const { locale } = useI18n();
  const weight = value ?? 1;
  const message =
    Number.isFinite(weight) && weight >= 0
      ? error === null
        ? null
        : COPY[locale].weightInvalid
      : COPY[locale].weightInvalid;
  return (
    <label className="field weight-field" htmlFor={id}>
      <span className="field-label">
        <strong>{label}</strong>
      </span>
      <input
        id={id}
        type="number"
        min={0}
        step="any"
        value={Number.isFinite(weight) ? weight : ''}
        disabled={disabled}
        aria-invalid={message === null ? undefined : true}
        aria-describedby={message === null ? undefined : `${id}-error`}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
      {message === null ? null : (
        <small className="field-error" id={`${id}-error`}>
          {message}
        </small>
      )}
    </label>
  );
}

function formatResult(result: number | null, locale: 'de' | 'en', missing: string): string {
  return result === null || !Number.isFinite(result)
    ? missing
    : new Intl.NumberFormat(locale, {
        maximumFractionDigits: 2,
        notation: Math.abs(result) >= 1e9 ? 'scientific' : 'standard',
      }).format(result);
}

function formatWeight(weight: number, locale: 'de' | 'en', missing: string): string {
  if (!Number.isFinite(weight)) return missing;
  return new Intl.NumberFormat(locale, {
    maximumSignificantDigits: 10,
    notation:
      weight !== 0 && (Math.abs(weight) < 0.000001 || Math.abs(weight) >= 1e9)
        ? 'scientific'
        : 'standard',
  }).format(weight);
}
