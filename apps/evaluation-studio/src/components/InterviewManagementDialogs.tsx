import { ApiError, type EvaluableInterview } from '@orgscience/api-client';
import { INTERVIEW_DISPLAY_NAME_MAX_LENGTH, type SupportedLocale } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { LoaderCircle, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { interviewDisplayName } from '../studio-api.js';
import { Modal } from './Modal.js';

const COPY = {
  de: {
    rename: 'Interview umbenennen',
    renameDetail:
      'Nur der Anzeigename wird geändert. Leitfaden, Aussagen und Auswertungen bleiben unverändert.',
    name: 'Interviewname',
    save: 'Speichern',
    reset: 'Leitfadentitel als Namen verwenden',
    cancel: 'Abbrechen',
    delete: 'Interview löschen',
    deleteConfirm: 'Endgültig löschen',
    deleteDetail:
      'Das Interview mit seinem Transkript, seinen Auswertungen und technischen Ereignissen wird dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.',
    guidePreserved: 'Der Leitfaden und die Bewertungsprofile bleiben erhalten.',
    renameFailed: 'Das Interview konnte nicht umbenannt werden.',
    deleteFailed: 'Das Interview konnte nicht gelöscht werden.',
    busy: 'Das Interview oder eine Auswertung wird noch verarbeitet. Pausiere oder beende ein laufendes Interview und warte, bis die Verarbeitung abgeschlossen ist.',
    missing:
      'Dieses Interview ist nicht mehr verfügbar. Schließe den Dialog und lade die Interviewliste neu.',
  },
  en: {
    rename: 'Rename interview',
    renameDetail:
      'Only the display name is changed. The guide, statements and evaluations remain unchanged.',
    name: 'Interview name',
    save: 'Save',
    reset: 'Use the guide title as the name',
    cancel: 'Cancel',
    delete: 'Delete interview',
    deleteConfirm: 'Delete permanently',
    deleteDetail:
      'The interview, its transcript, evaluations and technical events will be permanently deleted. This action cannot be undone.',
    guidePreserved: 'The guide and evaluation profiles are kept.',
    renameFailed: 'The interview could not be renamed.',
    deleteFailed: 'The interview could not be deleted.',
    busy: 'The interview or an evaluation is still being processed. Pause or end an active interview and wait for processing to finish.',
    missing:
      'This interview is no longer available. Close the dialog and reload the interview list.',
  },
} as const;

interface InterviewDialogProps {
  readonly interview: EvaluableInterview;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
}

export function RenameInterviewDialog({
  interview,
  busy,
  error,
  onConfirm,
  onClose,
}: InterviewDialogProps & { readonly onConfirm: (displayName: string | null) => void }): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const [name, setName] = useState(interviewDisplayName(interview));
  return (
    <Modal
      title={copy.rename}
      description={copy.renameDetail}
      interfaceLanguage={locale}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="text-button" type="button" disabled={busy} onClick={onClose}>
            {copy.cancel}
          </button>
          <button
            className="icon-button"
            type="button"
            title={copy.reset}
            aria-label={copy.reset}
            disabled={busy || interview.summary.displayName == null}
            onClick={() => onConfirm(null)}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={
              busy ||
              name.trim().length === 0 ||
              name.trim().length > INTERVIEW_DISPLAY_NAME_MAX_LENGTH
            }
            onClick={() => onConfirm(name.trim())}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <Save size={15} aria-hidden="true" />
            )}
            {copy.save}
          </button>
        </>
      }
    >
      <InterviewIdentity interview={interview} />
      <label className="field" htmlFor="rename-interview-name">
        <span className="field-label">
          <strong>{copy.name}</strong>
        </span>
        <input
          id="rename-interview-name"
          value={name}
          maxLength={INTERVIEW_DISPLAY_NAME_MAX_LENGTH}
          data-modal-initial-focus
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <InterviewDialogError error={error} />
    </Modal>
  );
}

export function DeleteInterviewDialog({
  interview,
  busy,
  error,
  onConfirm,
  onClose,
}: InterviewDialogProps & { readonly onConfirm: () => void }): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  return (
    <Modal
      title={copy.delete}
      description={copy.deleteDetail}
      interfaceLanguage={locale}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button
            className="text-button"
            type="button"
            data-modal-initial-focus
            disabled={busy}
            onClick={onClose}
          >
            {copy.cancel}
          </button>
          <button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}
            {copy.deleteConfirm}
          </button>
        </>
      }
    >
      <InterviewIdentity interview={interview} />
      <p>{copy.guidePreserved}</p>
      <InterviewDialogError error={error} />
    </Modal>
  );
}

function InterviewIdentity({ interview }: { readonly interview: EvaluableInterview }): ReactNode {
  return (
    <div className="interview-management-identity">
      <strong>{interviewDisplayName(interview)}</strong>
      <code>{interview.summary.interviewId}</code>
    </div>
  );
}

function InterviewDialogError({ error }: { readonly error: string | null }): ReactNode {
  return error === null ? null : (
    <p className="dialog-error" role="alert">
      {error}
    </p>
  );
}

export function interviewManagementError(
  reason: unknown,
  kind: 'rename' | 'delete',
  locale: SupportedLocale,
): string {
  const copy = COPY[locale];
  if (reason instanceof ApiError && reason.status === 409) return copy.busy;
  if (reason instanceof ApiError && reason.status === 404) return copy.missing;
  return kind === 'rename' ? copy.renameFailed : copy.deleteFailed;
}
