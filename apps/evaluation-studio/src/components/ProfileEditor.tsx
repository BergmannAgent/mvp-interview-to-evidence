import { EVALUATION_PROFILE_LIMITS, type EvaluationProfileContent } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CirclePlus,
  GripVertical,
  LockKeyhole,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import {
  addDimension,
  addItem,
  firstError,
  itemEntriesByDimensionPosition,
  moveDimension,
  moveItem,
  removeDimension,
  removeItem,
  updateAnchor,
  updateDimension,
  updateDimensionWeight,
  updateItem,
  updateItemWeight,
  updateMetadata,
  type DraftValidation,
} from '../profile-draft.js';
import { CalculationEditor, WeightField } from './CalculationEditor.js';
import { profileUiError } from './profile-ui-errors.js';

const COPY = {
  de: {
    profile: 'Profil',
    framework: 'Fachlicher Rahmen',
    frameworkDetail:
      'Name, Beschreibung und Coder-Prompt gelten unabhängig vom Interviewleitfaden.',
    name: 'Profilname',
    description: 'Beschreibung',
    coderPrompt: 'Fachlicher Coder-Prompt',
    coderHint:
      'Nur fachliche Codieranweisungen. Evidenzregeln und Ausgabeformat bleiben serverseitig gesperrt.',
    scale: 'Skala 1 bis 7',
    structure: 'Dimensionen und Items',
    dimensions: 'Dimensionen',
    dimension: 'Dimension',
    dimensionId: 'Stabile Dimensions-ID',
    dimensionWeight: 'Dimensionsgewicht',
    itemWeight: 'Itemgewicht',
    addItem: (name: string) => `Item zu ${name} hinzufügen`,
    locked: 'Technische Einstellungen sind gesperrt',
    lockedDetail:
      'Modell, Provider, Zugangsdaten, Timeout, Retries und das strukturierte Ausgabeformat werden nicht in Bewertungsprofilen gespeichert.',
    invalidId: 'ungültige ID',
    unnamedItem: 'Unbenanntes Item',
    anchors: '7 Anker',
    itemName: 'Item-Bezeichnung',
    itemId: 'Stabile Item-ID',
    instruction: 'Fachliche Coding Instruction',
    anchorCriteria: 'Ankerkriterien 1 bis 7',
    up: (name: string) => `${name} nach oben`,
    down: (name: string) => `${name} nach unten`,
    remove: (name: string) => `${name} entfernen`,
  },
  en: {
    profile: 'Profile',
    framework: 'Evaluation framework',
    frameworkDetail:
      'Name, description and coder prompt apply independently of the interview guide.',
    name: 'Profile name',
    description: 'Description',
    coderPrompt: 'Evaluation coder prompt',
    coderHint:
      'Evaluation instructions only. Evidence rules and output format remain locked on the server.',
    scale: 'Scale 1 to 7',
    structure: 'Dimensions and items',
    dimensions: 'Dimensions',
    dimension: 'Dimension',
    dimensionId: 'Stable dimension ID',
    dimensionWeight: 'Dimension weight',
    itemWeight: 'Item weight',
    addItem: (name: string) => `Add item to ${name}`,
    locked: 'Technical settings are locked',
    lockedDetail:
      'Model, provider, credentials, timeout, retries and the structured output format are not stored in evaluation profiles.',
    invalidId: 'invalid ID',
    unnamedItem: 'Unnamed item',
    anchors: '7 anchors',
    itemName: 'Item label',
    itemId: 'Stable item ID',
    instruction: 'Evaluation coding instruction',
    anchorCriteria: 'Anchor criteria 1 to 7',
    up: (name: string) => `Move ${name} up`,
    down: (name: string) => `Move ${name} down`,
    remove: (name: string) => `Remove ${name}`,
  },
} as const;

interface ProfileEditorProps {
  readonly content: EvaluationProfileContent;
  readonly validation: DraftValidation;
  readonly disabled: boolean;
  readonly onChange: (content: EvaluationProfileContent) => void;
}

export function ProfileEditor({
  content,
  validation,
  disabled,
  onChange,
}: ProfileEditorProps): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const itemGroups = itemEntriesByDimensionPosition(content);
  return (
    <form className="profile-editor" onSubmit={(event) => event.preventDefault()} noValidate>
      <section className="editor-section metadata-section" aria-labelledby="profile-basics-title">
        <SectionHeading
          eyebrow={copy.profile}
          title={copy.framework}
          id="profile-basics-title"
          detail={copy.frameworkDetail}
        />
        <div className="metadata-grid">
          <TextField
            id="profile-name"
            label={copy.name}
            value={content.name}
            maxLength={EVALUATION_PROFILE_LIMITS.maximumNameLength}
            error={firstError(validation, 'name')}
            disabled={disabled}
            onChange={(value) => onChange(updateMetadata(content, 'name', value))}
          />
          <TextField
            id="profile-description"
            label={copy.description}
            value={content.description}
            maxLength={EVALUATION_PROFILE_LIMITS.maximumDescriptionLength}
            error={firstError(validation, 'description')}
            disabled={disabled}
            multiline
            onChange={(value) => onChange(updateMetadata(content, 'description', value))}
          />
        </div>
        <TextField
          id="profile-coder-prompt"
          label={copy.coderPrompt}
          value={content.coderPrompt}
          maxLength={EVALUATION_PROFILE_LIMITS.maximumCoderPromptLength}
          error={firstError(validation, 'coderPrompt')}
          disabled={disabled}
          multiline
          tall
          hint={copy.coderHint}
          onChange={(value) => onChange(updateMetadata(content, 'coderPrompt', value))}
        />
      </section>

      <section className="editor-section" aria-labelledby="profile-structure-title">
        <SectionHeading
          eyebrow={copy.scale}
          title={copy.structure}
          id="profile-structure-title"
          detail={`${String(content.dimensions.length)} ${copy.dimensions} · ${String(content.items.length)} Items`}
          action={
            <button
              className="secondary-button"
              type="button"
              disabled={
                disabled || content.dimensions.length >= EVALUATION_PROFILE_LIMITS.maximumDimensions
              }
              onClick={() => onChange(addDimension(content))}
            >
              <CirclePlus aria-hidden="true" size={15} />
              {copy.dimension}
            </button>
          }
        />

        <div className="dimension-editor-list">
          {content.dimensions.map((dimension, dimensionIndex) => {
            const items = itemGroups[dimensionIndex] ?? [];
            return (
              <section
                className="dimension-editor"
                key={dimensionEditorKey(dimensionIndex)}
                data-editor-key={dimensionEditorKey(dimensionIndex)}
                aria-labelledby={`dimension-${String(dimensionIndex)}-title`}
              >
                <div className="dimension-editor-header">
                  <GripVertical aria-hidden="true" className="drag-indicator" size={17} />
                  <div className="dimension-fields">
                    <TextField
                      id={`dimension-${String(dimensionIndex)}-name`}
                      label={copy.dimension}
                      value={dimension.name}
                      maxLength={EVALUATION_PROFILE_LIMITS.maximumNameLength}
                      error={firstError(validation, `dimensions.${String(dimensionIndex)}.name`)}
                      disabled={disabled}
                      onChange={(value) =>
                        onChange(updateDimension(content, dimensionIndex, 'name', value))
                      }
                    />
                    <TextField
                      id={`dimension-${String(dimensionIndex)}-id`}
                      label={copy.dimensionId}
                      value={dimension.dimensionId}
                      error={firstError(
                        validation,
                        `dimensions.${String(dimensionIndex)}.dimensionId`,
                      )}
                      disabled={disabled}
                      mono
                      onChange={(value) =>
                        onChange(updateDimension(content, dimensionIndex, 'dimensionId', value))
                      }
                    />
                    <WeightField
                      id={`dimension-${String(dimensionIndex)}-weight`}
                      label={copy.dimensionWeight}
                      value={dimension.weight}
                      error={firstError(validation, `dimensions.${String(dimensionIndex)}.weight`)}
                      disabled={disabled}
                      onChange={(weight) =>
                        onChange(updateDimensionWeight(content, dimensionIndex, weight))
                      }
                    />
                  </div>
                  <ReorderControls
                    label={`${copy.dimension} ${dimension.name}`}
                    first={dimensionIndex === 0}
                    last={dimensionIndex === content.dimensions.length - 1}
                    disabled={disabled}
                    onUp={() => onChange(moveDimension(content, dimensionIndex, -1))}
                    onDown={() => onChange(moveDimension(content, dimensionIndex, 1))}
                    onRemove={() => onChange(removeDimension(content, dimensionIndex))}
                    removeDisabled={content.dimensions.length <= 1}
                  />
                </div>
                <h3 className="sr-only" id={`dimension-${String(dimensionIndex)}-title`}>
                  {dimension.name || `${copy.dimension} ${String(dimensionIndex + 1)}`}
                </h3>

                <div className="item-editor-list">
                  {items.map(({ itemIndex }, siblingIndex) => (
                    <ItemEditor
                      key={itemEditorKey(itemIndex)}
                      content={content}
                      validation={validation}
                      itemIndex={itemIndex}
                      dimensionIndex={dimensionIndex}
                      siblingIndex={siblingIndex}
                      siblingCount={items.length}
                      disabled={disabled}
                      onChange={onChange}
                    />
                  ))}
                </div>
                <button
                  className="add-item-button"
                  type="button"
                  disabled={
                    disabled || content.items.length >= EVALUATION_PROFILE_LIMITS.maximumItems
                  }
                  onClick={() => onChange(addItem(content, dimensionIndex))}
                >
                  <CirclePlus aria-hidden="true" size={14} />
                  {copy.addItem(dimension.name || copy.dimension)}
                </button>
              </section>
            );
          })}
        </div>
      </section>

      <CalculationEditor
        content={content}
        validation={validation}
        disabled={disabled}
        onChange={onChange}
      />

      <section className="locked-note" aria-labelledby="editor-locked-title">
        <LockKeyhole aria-hidden="true" size={17} />
        <div>
          <h2 id="editor-locked-title">{copy.locked}</h2>
          <p>{copy.lockedDetail}</p>
        </div>
      </section>
    </form>
  );
}

export function dimensionEditorKey(dimensionIndex: number): string {
  return `dimension-position-${String(dimensionIndex)}`;
}

export function itemEditorKey(itemIndex: number): string {
  return `item-position-${String(itemIndex)}`;
}

function ItemEditor({
  content,
  validation,
  itemIndex,
  dimensionIndex,
  siblingIndex,
  siblingCount,
  disabled,
  onChange,
}: {
  readonly content: EvaluationProfileContent;
  readonly validation: DraftValidation;
  readonly itemIndex: number;
  readonly dimensionIndex: number;
  readonly siblingIndex: number;
  readonly siblingCount: number;
  readonly disabled: boolean;
  readonly onChange: (content: EvaluationProfileContent) => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const item = content.items[itemIndex];
  if (item === undefined) return null;
  return (
    <details
      className="item-editor"
      data-editor-key={itemEditorKey(itemIndex)}
      open={siblingIndex === 0}
    >
      <summary>
        <span>
          <code>{item.itemId || copy.invalidId}</code>
          <strong>{item.name || copy.unnamedItem}</strong>
        </span>
        <span className="anchor-count">{copy.anchors}</span>
        <ChevronDown aria-hidden="true" className="chevron" size={17} />
      </summary>
      <div className="item-editor-body">
        <div className="item-heading-row">
          <div className="item-fields">
            <TextField
              id={`item-${String(itemIndex)}-name`}
              label={copy.itemName}
              value={item.name}
              maxLength={EVALUATION_PROFILE_LIMITS.maximumItemLabelLength}
              error={firstError(validation, `items.${String(itemIndex)}.name`)}
              disabled={disabled}
              onChange={(value) => onChange(updateItem(content, itemIndex, 'name', value))}
            />
            <TextField
              id={`item-${String(itemIndex)}-id`}
              label={copy.itemId}
              value={item.itemId}
              error={firstError(validation, `items.${String(itemIndex)}.itemId`)}
              disabled={disabled}
              mono
              onChange={(value) => onChange(updateItem(content, itemIndex, 'itemId', value))}
            />
            <WeightField
              id={`item-${String(itemIndex)}-weight`}
              label={copy.itemWeight}
              value={item.weight}
              error={firstError(validation, `items.${String(itemIndex)}.weight`)}
              disabled={disabled}
              onChange={(weight) => onChange(updateItemWeight(content, itemIndex, weight))}
            />
          </div>
          <ReorderControls
            label={`Item ${item.name}`}
            first={siblingIndex === 0}
            last={siblingIndex === siblingCount - 1}
            disabled={disabled}
            onUp={() => onChange(moveItem(content, dimensionIndex, siblingIndex, -1))}
            onDown={() => onChange(moveItem(content, dimensionIndex, siblingIndex, 1))}
            onRemove={() => onChange(removeItem(content, itemIndex))}
            removeDisabled={siblingCount <= 1}
          />
        </div>

        <TextField
          id={`item-${String(itemIndex)}-instruction`}
          label={copy.instruction}
          value={item.codingInstruction}
          maxLength={EVALUATION_PROFILE_LIMITS.maximumCodingInstructionLength}
          error={firstError(validation, `items.${String(itemIndex)}.codingInstruction`)}
          disabled={disabled}
          multiline
          onChange={(value) => onChange(updateItem(content, itemIndex, 'codingInstruction', value))}
        />

        <fieldset className="anchor-editor-grid">
          <legend>{copy.anchorCriteria}</legend>
          {item.anchors.map((anchor, anchorIndex) => {
            const error = firstError(
              validation,
              `items.${String(itemIndex)}.anchors.${String(anchorIndex)}.criterion`,
            );
            const errorId = `item-${String(itemIndex)}-anchor-${String(anchor.score)}-error`;
            return (
              <label
                key={anchor.score}
                htmlFor={`item-${String(itemIndex)}-anchor-${String(anchor.score)}`}
              >
                <span>
                  <strong>{anchor.score}</strong>
                  <small>Score</small>
                </span>
                <textarea
                  id={`item-${String(itemIndex)}-anchor-${String(anchor.score)}`}
                  value={anchor.criterion}
                  maxLength={EVALUATION_PROFILE_LIMITS.maximumAnchorCriterionLength}
                  rows={4}
                  disabled={disabled}
                  aria-invalid={error === null ? undefined : true}
                  aria-describedby={error === null ? undefined : errorId}
                  onChange={(event) =>
                    onChange(updateAnchor(content, itemIndex, anchorIndex, event.target.value))
                  }
                />
                <FieldError id={errorId} error={error} />
              </label>
            );
          })}
        </fieldset>
      </div>
    </details>
  );
}

function TextField({
  id,
  label,
  value,
  maxLength,
  error,
  hint,
  disabled,
  multiline = false,
  tall = false,
  mono = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly maxLength?: number;
  readonly error: string | null;
  readonly hint?: string;
  readonly disabled: boolean;
  readonly multiline?: boolean;
  readonly tall?: boolean;
  readonly mono?: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const describedBy = [
    hint === undefined ? null : `${id}-hint`,
    error === null ? null : `${id}-error`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
  return (
    <label className={`field ${mono ? 'is-mono' : ''}`} htmlFor={id}>
      <span className="field-label">
        <strong>{label}</strong>
        {maxLength === undefined ? null : (
          <small>
            {String(value.length)} / {String(maxLength)}
          </small>
        )}
      </span>
      {multiline ? (
        <textarea
          id={id}
          className={tall ? 'is-tall' : undefined}
          value={value}
          rows={tall ? 8 : 3}
          maxLength={maxLength}
          disabled={disabled}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint === undefined ? null : (
        <small className="field-hint" id={`${id}-hint`}>
          {hint}
        </small>
      )}
      <FieldError id={`${id}-error`} error={error} />
    </label>
  );
}

function FieldError({
  id,
  error,
}: {
  readonly id: string;
  readonly error: string | null;
}): ReactNode {
  const { locale } = useI18n();
  return error === null ? null : (
    <small className="field-error" id={id}>
      {profileUiError(error, locale)}
    </small>
  );
}

function ReorderControls({
  label,
  first,
  last,
  disabled,
  removeDisabled,
  onUp,
  onDown,
  onRemove,
}: {
  readonly label: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly removeDisabled: boolean;
  readonly onUp: () => void;
  readonly onDown: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  return (
    <div className="reorder-controls">
      <button
        type="button"
        className="icon-button"
        title={copy.up(label)}
        aria-label={copy.up(label)}
        disabled={disabled || first}
        onClick={onUp}
      >
        <ArrowUp aria-hidden="true" size={15} />
      </button>
      <button
        type="button"
        className="icon-button"
        title={copy.down(label)}
        aria-label={copy.down(label)}
        disabled={disabled || last}
        onClick={onDown}
      >
        <ArrowDown aria-hidden="true" size={15} />
      </button>
      <button
        type="button"
        className="icon-button danger-icon"
        title={copy.remove(label)}
        aria-label={copy.remove(label)}
        disabled={disabled || removeDisabled}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  id,
  detail,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly id: string;
  readonly detail: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <header className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id={id}>{title}</h2>
        <p>{detail}</p>
      </div>
      {action}
    </header>
  );
}
