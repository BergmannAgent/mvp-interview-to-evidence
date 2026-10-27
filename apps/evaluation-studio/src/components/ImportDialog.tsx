import {
  resolveProfileCalculation,
  type EvaluationProfile,
  type EvaluationProfilePortable,
} from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Check, FileJson, FileSpreadsheet, FileUp, LoaderCircle, Replace } from 'lucide-react';
import { useState, type ChangeEvent, type ReactNode } from 'react';

import {
  confirmImport,
  downloadJsonArtifact,
  downloadXlsxArtifact,
  formatFieldPath,
  operationError,
  previewJsonFile,
  previewXlsxFile,
  type EvaluationStudioApi,
  type ImportReplaceTarget,
  type ImportPreview,
  type StudioOperationError,
} from '../studio-api.js';
import { Modal } from './Modal.js';
import { profileUiError } from './profile-ui-errors.js';

const COPY = {
  de: {
    title: 'Profil importieren',
    description:
      'Die Datei wird zuerst serverseitig validiert und erst nach Bestätigung gespeichert.',
    fileError: 'Die Importdatei konnte nicht geprüft werden.',
    templateError: 'Das generische Template konnte nicht geladen werden.',
    saveError: 'Der Profilimport konnte nicht gespeichert werden.',
    cancel: 'Abbrechen',
    confirm: 'Import bestätigen',
    format: 'Importformat',
    checking: 'Datei wird geprüft',
    choose: (kind: string) => `${kind} auswählen`,
    chooseProfile: (kind: string) => `${kind}-Profil auswählen`,
    template: 'Generisches Template',
    empty: 'Nach der Auswahl erscheint hier das normalisierte Profil.',
    mode: 'Speichermodus',
    create: 'Als neues Profil',
    createHint: 'Verwendet die Profil-ID aus der Datei.',
    replace: 'Ausgewähltes Profil ersetzen',
    noTarget: 'Kein gespeichertes Profil ausgewählt',
    target: 'Unveränderliches Ersetzungsziel',
    targetSelected: 'Dieses Ersetzungsziel wurde beim Öffnen festgehalten',
    targetAvailable: 'Verfügbares Ersetzungsziel, beim Öffnen festgehalten',
    revision: 'Versionsstand',
    preview: 'Validierte Vorschau',
    dimensions: 'Dimensionen',
    anchors: 'Anker',
    file: 'Datei',
    profileDescription: 'Beschreibung',
    noDescription: 'Keine Beschreibung',
    coderPrompt: 'Vollständiger Coder-Prompt',
    scale: 'Skala',
    to: 'bis',
    schema: 'Schema',
    order: 'Reihenfolge',
    dimensionId: 'Dimensions-ID',
    itemPosition: (item: number, dimension: number) =>
      `Item ${String(item)} in Dimension ${String(dimension)}`,
    instruction: 'Coding Instruction',
    anchorCriteria: 'Ankerkriterien 1 bis 7',
    conflict: 'Versionskonflikt',
    importError: 'Import nicht möglich',
    calculation: 'Berechnung',
    weightedMean: 'Gewichtetes Mittel',
    formula: 'Formel',
    expression: 'Formelausdruck',
    dimensionWeight: 'Dimensionsgewicht',
    itemWeight: 'Itemgewicht',
    effectiveWeight: 'Effektives Gewicht',
  },
  en: {
    title: 'Import profile',
    description: 'The file is validated on the server first and saved only after confirmation.',
    fileError: 'The import file could not be validated.',
    templateError: 'The generic template could not be loaded.',
    saveError: 'The profile import could not be saved.',
    cancel: 'Cancel',
    confirm: 'Confirm import',
    format: 'Import format',
    checking: 'Checking file',
    choose: (kind: string) => `Choose ${kind}`,
    chooseProfile: (kind: string) => `Choose ${kind} profile`,
    template: 'Generic template',
    empty: 'The normalized profile will appear here after you select a file.',
    mode: 'Save mode',
    create: 'As a new profile',
    createHint: 'Uses the profile ID from the file.',
    replace: 'Replace selected profile',
    noTarget: 'No saved profile selected',
    target: 'Fixed replacement target',
    targetSelected: 'This replacement target was captured when opening the dialog',
    targetAvailable: 'Available replacement target, captured when opening the dialog',
    revision: 'Revision',
    preview: 'Validated preview',
    dimensions: 'Dimensions',
    anchors: 'Anchors',
    file: 'File',
    profileDescription: 'Description',
    noDescription: 'No description',
    coderPrompt: 'Complete coder prompt',
    scale: 'Scale',
    to: 'to',
    schema: 'Schema',
    order: 'Order',
    dimensionId: 'Dimension ID',
    itemPosition: (item: number, dimension: number) =>
      `Item ${String(item)} in dimension ${String(dimension)}`,
    instruction: 'Coding instruction',
    anchorCriteria: 'Anchor criteria 1 to 7',
    conflict: 'Version conflict',
    importError: 'Import unavailable',
    calculation: 'Calculation',
    weightedMean: 'Weighted mean',
    formula: 'Formula',
    expression: 'Formula expression',
    dimensionWeight: 'Dimension weight',
    itemWeight: 'Item weight',
    effectiveWeight: 'Effective weight',
  },
} as const;

type ImportKind = 'json' | 'xlsx';
type ImportMode = 'create' | 'replace';

export function ImportDialog({
  api,
  replaceTarget,
  onImported,
  onClose,
}: {
  readonly api: EvaluationStudioApi;
  readonly replaceTarget: ImportReplaceTarget | null;
  readonly onImported: (profile: EvaluationProfile) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const [kind, setKind] = useState<ImportKind>('json');
  const [mode, setMode] = useState<ImportMode>('create');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StudioOperationError | null>(null);

  const loadFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setBusy(true);
    setPreview(null);
    setError(null);
    try {
      setPreview(
        kind === 'json' ? await previewJsonFile(api, file) : await previewXlsxFile(api, file),
      );
    } catch (reason) {
      setError(operationError(reason, copy.fileError));
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'json') downloadJsonArtifact(await api.getJsonTemplate());
      else downloadXlsxArtifact(await api.getXlsxTemplate());
    } catch (reason) {
      setError(operationError(reason, copy.templateError));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    const target = mode === 'replace' ? replaceTarget : null;
    try {
      onImported(await confirmImport(api, preview, target));
    } catch (reason) {
      setError(operationError(reason, copy.saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={copy.title}
      description={copy.description}
      interfaceLanguage={locale}
      wide
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="text-button" type="button" disabled={busy} onClick={onClose}>
            {copy.cancel}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || preview === null || (mode === 'replace' && replaceTarget === null)}
            onClick={() => void commit()}
          >
            {busy ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Check aria-hidden="true" size={15} />
            )}
            {copy.confirm}
          </button>
        </>
      }
    >
      <div className="import-tabs" role="tablist" aria-label={copy.format}>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'json'}
          className={kind === 'json' ? 'is-active' : ''}
          disabled={busy}
          onClick={() => {
            setKind('json');
            setPreview(null);
            setError(null);
          }}
        >
          <FileJson aria-hidden="true" size={16} /> JSON
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'xlsx'}
          className={kind === 'xlsx' ? 'is-active' : ''}
          disabled={busy}
          onClick={() => {
            setKind('xlsx');
            setPreview(null);
            setError(null);
          }}
        >
          <FileSpreadsheet aria-hidden="true" size={16} /> Excel (.xlsx)
        </button>
      </div>

      <div className="import-actions">
        <label className="file-button">
          {busy ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <FileUp aria-hidden="true" size={16} />
          )}
          {busy ? copy.checking : copy.choose(kind.toUpperCase())}
          <input
            type="file"
            data-modal-initial-focus
            aria-label={copy.chooseProfile(kind.toUpperCase())}
            accept={
              kind === 'json'
                ? 'application/json,.json'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx'
            }
            disabled={busy}
            onChange={(event) => void loadFile(event)}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => void downloadTemplate()}
        >
          {kind === 'json' ? (
            <FileJson aria-hidden="true" size={15} />
          ) : (
            <FileSpreadsheet aria-hidden="true" size={15} />
          )}
          {copy.template}
        </button>
      </div>

      {error === null ? null : <ImportError error={error} />}
      {preview === null ? (
        <div className="import-empty">
          <FileUp aria-hidden="true" size={24} />
          <p>{copy.empty}</p>
        </div>
      ) : (
        <ImportPreviewPanel preview={preview} />
      )}

      <fieldset className="import-mode" disabled={busy || preview === null}>
        <legend>{copy.mode}</legend>
        <label>
          <input
            type="radio"
            name="import-mode"
            checked={mode === 'create'}
            onChange={() => setMode('create')}
          />
          <span>
            <strong>{copy.create}</strong>
            <small>{copy.createHint}</small>
          </span>
        </label>
        <label className={replaceTarget === null ? 'is-disabled' : ''}>
          <input
            type="radio"
            name="import-mode"
            checked={mode === 'replace'}
            disabled={replaceTarget === null}
            onChange={() => setMode('replace')}
          />
          <Replace aria-hidden="true" size={15} />
          <span>
            <strong>{copy.replace}</strong>
            <small>
              {replaceTarget === null
                ? copy.noTarget
                : `${replaceTarget.name} · ${replaceTarget.profileId}`}
            </small>
          </span>
        </label>
      </fieldset>
      {replaceTarget !== null ? (
        <aside className="replace-target" aria-label={copy.target}>
          <strong>{mode === 'replace' ? copy.targetSelected : copy.targetAvailable}</strong>
          <span>{replaceTarget.name}</span>
          <code>{replaceTarget.profileId}</code>
          <small>
            {copy.revision}{' '}
            <time dateTime={replaceTarget.updatedAt}>{replaceTarget.updatedAt}</time>
          </small>
        </aside>
      ) : null}
    </Modal>
  );
}

export function ImportPreviewPanel({ preview }: { readonly preview: ImportPreview }): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const profile: EvaluationProfilePortable = preview.document.profile;
  const calculation = resolveProfileCalculation(profile);
  return (
    <section className="import-preview" aria-labelledby="import-preview-title">
      <header>
        <div>
          <span className="eyebrow">{copy.preview}</span>
          <h3 id="import-preview-title">{profile.name}</h3>
          <code>{profile.profileId}</code>
        </div>
        <dl>
          <div>
            <dt>{copy.dimensions}</dt>
            <dd>{profile.dimensions.length}</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{profile.items.length}</dd>
          </div>
          <div>
            <dt>{copy.anchors}</dt>
            <dd>{profile.items.length * 7}</dd>
          </div>
        </dl>
      </header>
      {preview.kind === 'xlsx' ? (
        <p className="import-source">
          {copy.file} <strong>{preview.source.fileName}</strong> · Template v
          {preview.source.templateVersion}
        </p>
      ) : (
        <p className="import-source">
          {copy.file} <strong>{preview.fileName}</strong>
        </p>
      )}
      <div className="preview-profile-copy">
        <section>
          <h4>{copy.profileDescription}</h4>
          <p>{profile.description || copy.noDescription}</p>
        </section>
        <section>
          <h4>{copy.coderPrompt}</h4>
          <pre>{profile.coderPrompt}</pre>
        </section>
        <section>
          <h4>{copy.calculation}</h4>
          <p>{calculation.mode === 'formula' ? copy.formula : copy.weightedMean}</p>
          {calculation.mode === 'formula' ? (
            <pre aria-label={copy.expression}>{calculation.expression}</pre>
          ) : null}
        </section>
        <dl>
          <div>
            <dt>{copy.scale}</dt>
            <dd>
              {profile.scale.minimum} {copy.to} {profile.scale.maximum}
            </dd>
          </div>
          <div>
            <dt>{copy.schema}</dt>
            <dd>Version {preview.document.schemaVersion}</dd>
          </div>
        </dl>
      </div>
      <div className="preview-dimensions">
        {profile.dimensions.map((dimension, dimensionIndex) => (
          <details key={dimension.dimensionId}>
            <summary>
              <span>
                <strong>{dimension.name}</strong>
                <small>
                  {copy.order} {dimension.order + 1}
                </small>
                <small>
                  {copy.dimensionWeight}: {dimension.weight ?? 1}
                </small>
              </span>
              <code>{dimension.dimensionId}</code>
            </summary>
            <ul>
              {profile.items
                .filter((item) => item.dimensionId === dimension.dimensionId)
                .map((item, itemIndex) => (
                  <li key={item.itemId}>
                    <details className="preview-item">
                      <summary>
                        <span>
                          <strong>{item.name}</strong>
                          <small>{copy.itemPosition(itemIndex + 1, dimensionIndex + 1)}</small>
                        </span>
                        <code>{item.itemId}</code>
                      </summary>
                      <div className="preview-item-content">
                        <dl>
                          <div>
                            <dt>{copy.dimensionId}</dt>
                            <dd>
                              <code>{item.dimensionId}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>{copy.order}</dt>
                            <dd>{item.order + 1}</dd>
                          </div>
                          <div>
                            <dt>{copy.itemWeight}</dt>
                            <dd>{item.weight ?? 1}</dd>
                          </div>
                          <div>
                            <dt>{copy.effectiveWeight}</dt>
                            <dd>{(dimension.weight ?? 1) * (item.weight ?? 1)}</dd>
                          </div>
                        </dl>
                        <section>
                          <h5>{copy.instruction}</h5>
                          <p>{item.codingInstruction}</p>
                        </section>
                        <section>
                          <h5>{copy.anchorCriteria}</h5>
                          <ol className="preview-anchors">
                            {item.anchors.map((anchor) => (
                              <li key={anchor.score} value={anchor.score}>
                                <strong>Score {anchor.score}</strong>
                                <span>{anchor.criterion}</span>
                              </li>
                            ))}
                          </ol>
                        </section>
                      </div>
                    </details>
                  </li>
                ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

function ImportError({ error }: { readonly error: StudioOperationError }): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  return (
    <div className={error.conflict ? 'import-error is-conflict' : 'import-error'} role="alert">
      <strong>{error.conflict ? copy.conflict : copy.importError}</strong>
      <p>{profileUiError(error.message, locale)}</p>
      {error.fieldErrors.length === 0 ? null : (
        <ul>
          {error.fieldErrors.map((field, index) => (
            <li key={`${formatFieldPath(field.path)}:${String(index)}`}>
              <code>{formatFieldPath(field.path) || copy.file}</code>
              <span>{profileUiError(field.message, locale)}</span>
            </li>
          ))}
        </ul>
      )}
      {error.requestId === null ? null : <small>Request-ID: {error.requestId}</small>}
    </div>
  );
}
