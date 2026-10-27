import type { EvaluationProfileSummary } from '@orgscience/contracts';
import { useI18n } from '@orgscience/frontend-i18n';
import { Check, Plus, Search, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { Modal } from './Modal.js';

const COPY = {
  de: {
    title: 'Bewertungsprofil',
    manage: 'Profil verwalten',
    create: 'Neues Profil',
    search: 'Profile durchsuchen',
    loading: 'Profile werden geladen.',
    empty: 'Noch keine Profile vorhanden.',
    noMatches: 'Keine passenden Profile.',
  },
  en: {
    title: 'Evaluation profile',
    manage: 'Manage profile',
    create: 'New profile',
    search: 'Search profiles',
    loading: 'Loading profiles.',
    empty: 'No profiles yet.',
    noMatches: 'No matching profiles.',
  },
} as const;

export interface ProfileMenuProps {
  readonly profiles: readonly EvaluationProfileSummary[];
  readonly selectedProfileId: string | null;
  readonly search: string;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onSearch: (value: string) => void;
  readonly onSelect: (profileId: string) => void;
  readonly onManage: () => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}

export function ProfileMenu({
  profiles,
  selectedProfileId,
  search,
  loading,
  disabled,
  error,
  onSearch,
  onSelect,
  onManage,
  onCreate,
  onClose,
}: ProfileMenuProps): ReactNode {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const term = search.trim().toLocaleLowerCase();
  const visible = profiles.filter((profile) =>
    `${profile.name} ${profile.description} ${profile.profileId}`
      .toLocaleLowerCase()
      .includes(term),
  );
  return (
    <Modal
      title={copy.title}
      interfaceLanguage={locale}
      onClose={onClose}
      footer={
        <div className="profile-menu-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={disabled || selectedProfileId === null}
            onClick={onManage}
          >
            <Settings2 size={16} aria-hidden="true" />
            {copy.manage}
          </button>
          <button className="secondary-button" type="button" disabled={disabled} onClick={onCreate}>
            <Plus size={16} aria-hidden="true" />
            {copy.create}
          </button>
        </div>
      }
    >
      <label className="search-field" htmlFor="studio-profile-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">{copy.search}</span>
        <input
          id="studio-profile-search"
          data-modal-initial-focus
          type="search"
          value={search}
          placeholder={copy.search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
      {error === null ? null : (
        <p className="profile-menu-error" role="alert">
          {error}
        </p>
      )}
      <div className="profile-menu-list" aria-busy={loading}>
        {loading && profiles.length === 0 ? <p className="sidebar-state">{copy.loading}</p> : null}
        {!loading && visible.length === 0 ? (
          <p className="sidebar-state">{profiles.length === 0 ? copy.empty : copy.noMatches}</p>
        ) : null}
        {visible.map((profile) => (
          <button
            className="profile-menu-option"
            key={profile.profileId}
            type="button"
            disabled={disabled}
            aria-pressed={selectedProfileId === profile.profileId}
            onClick={() => onSelect(profile.profileId)}
          >
            <span>
              <strong>{profile.name}</strong>
              {profile.isDefault ? <small className="default-badge">default</small> : null}
              <small>{profile.description}</small>
            </span>
            <Check
              size={18}
              aria-hidden="true"
              className={selectedProfileId === profile.profileId ? '' : 'profile-check-hidden'}
            />
          </button>
        ))}
      </div>
    </Modal>
  );
}
