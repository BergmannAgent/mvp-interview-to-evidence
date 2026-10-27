import type { EvaluationProfile } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Copy, LoaderCircle, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Modal } from './Modal.js';

const COPY = {
  de: {
    duplicateTitle: 'Profil duplizieren',
    duplicateDescription:
      'Die Kopie erhält eine neue Profil-ID und ist nicht als default markiert.',
    suffix: 'Kopie',
    cancel: 'Abbrechen',
    duplicate: 'Duplizieren',
    copyName: 'Name der Kopie',
    deleteTitle: 'Profil löschen',
    delete: 'Endgültig löschen',
    deleteDescription: (name: string) =>
      `„${name}“ wird dauerhaft entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`,
    warning: 'Zu diesem Profil gespeicherte Prototyp-Auswertungen können ebenfalls entfallen.',
  },
  en: {
    duplicateTitle: 'Duplicate profile',
    duplicateDescription: 'The copy receives a new profile ID and is not marked as default.',
    suffix: 'Copy',
    cancel: 'Cancel',
    duplicate: 'Duplicate',
    copyName: 'Copy name',
    deleteTitle: 'Delete profile',
    delete: 'Delete permanently',
    deleteDescription: (name: string) =>
      `“${name}” will be permanently removed. This action cannot be undone.`,
    warning: 'Prototype evaluations saved for this profile may also be removed.',
  },
} as const;

export function DuplicateProfileDialog({
  profile,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly profile: EvaluationProfile;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: (name: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const [name, setName] = useState(`${profile.name} ${copy.suffix}`);
  return (
    <Modal
      title={copy.duplicateTitle}
      description={copy.duplicateDescription}
      interfaceLanguage={locale}
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
            disabled={busy || name.trim().length === 0}
            onClick={() => onConfirm(name)}
          >
            {busy ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Copy aria-hidden="true" size={15} />
            )}
            {copy.duplicate}
          </button>
        </>
      }
    >
      <label className="field" htmlFor="duplicate-profile-name">
        <span className="field-label">
          <strong>{copy.copyName}</strong>
        </span>
        <input
          id="duplicate-profile-name"
          value={name}
          data-modal-initial-focus
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error === null ? null : (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function DeleteProfileDialog({
  profile,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly profile: EvaluationProfile;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  return (
    <Modal
      title={copy.deleteTitle}
      description={copy.deleteDescription(profile.name)}
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
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Trash2 aria-hidden="true" size={15} />
            )}
            {copy.delete}
          </button>
        </>
      }
    >
      <div className="delete-warning">
        <strong>{profile.profileId}</strong>
        <span>{copy.warning}</span>
      </div>
      {error === null ? null : (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
