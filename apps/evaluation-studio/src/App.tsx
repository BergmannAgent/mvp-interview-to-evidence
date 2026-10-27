import type {
  EvaluationProfile,
  EvaluationProfileContent,
  EvaluationProfileLockedGuardrails,
  EvaluationProfileSummary,
} from '@orgscience/contracts';
import { LanguageSwitcher, useI18n } from '@orgscience/frontend-i18n';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileDown,
  FileUp,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { DeleteProfileDialog, DuplicateProfileDialog } from './components/ActionDialogs.js';
import { EvaluationWorkspace } from './components/EvaluationWorkspace.js';
import { GuardrailsPanel } from './components/GuardrailsPanel.js';
import { ImportDialog } from './components/ImportDialog.js';
import { ProfileEditor } from './components/ProfileEditor.js';
import { ProfileMenu } from './components/ProfileMenu.js';
import {
  contentFromProfile,
  isSameContent,
  starterProfileContent,
  validateDraft,
} from './profile-draft.js';
import {
  captureImportReplaceTarget,
  downloadJsonArtifact,
  operationError,
  saveProfile,
  studioApi,
  type EvaluationStudioApi,
  type StudioOperationError,
} from './studio-api.js';
import { studioAppCopy } from './studio-app-copy.js';

type BusyOperation = 'save' | 'duplicate' | 'delete' | 'export' | null;

type ActiveDialog =
  | {
      readonly kind: 'import';
      readonly replaceTarget: ReturnType<typeof captureImportReplaceTarget>;
    }
  | { readonly kind: 'duplicate'; readonly profile: EvaluationProfile }
  | { readonly kind: 'delete'; readonly profile: EvaluationProfile }
  | null;

export function App({ api = studioApi }: { readonly api?: EvaluationStudioApi }): ReactNode {
  const { locale } = useI18n();
  const copy = studioAppCopy(locale);
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const [view, setView] = useState<'profiles' | 'evaluation'>(readStudioView);
  const [profiles, setProfiles] = useState<readonly EvaluationProfileSummary[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(readProfileSelection);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [profile, setProfile] = useState<EvaluationProfile | null>(null);
  const [draft, setDraft] = useState<EvaluationProfileContent | null>(null);
  const [draftReset, setDraftReset] = useState(0);
  const [baseline, setBaseline] = useState<EvaluationProfileContent | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<StudioOperationError | null>(null);
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [guardrails, setGuardrails] = useState<EvaluationProfileLockedGuardrails | null>(null);
  const [guardrailsLoading, setGuardrailsLoading] = useState(true);
  const [guardrailsError, setGuardrailsError] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const directoryRequest = useRef(0);
  const profileRequest = useRef(0);

  const validation = useMemo(() => (draft === null ? null : validateDraft(draft)), [draft]);
  const dirty =
    draft !== null && (creating || baseline === null || !isSameContent(draft, baseline));
  const disabled = busy !== null || profileLoading;

  const loadDirectory = useCallback(async (): Promise<
    readonly EvaluationProfileSummary[] | null
  > => {
    const request = ++directoryRequest.current;
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const response = await api.listProfiles();
      if (request !== directoryRequest.current) return null;
      setProfiles(response.profiles);
      return response.profiles;
    } catch (reason) {
      if (request !== directoryRequest.current) return null;
      setDirectoryError(operationError(reason, copyRef.current.listFailed).message);
      return null;
    } finally {
      if (request === directoryRequest.current) setDirectoryLoading(false);
    }
  }, [api]);

  const loadGuardrails = useCallback(async (): Promise<void> => {
    setGuardrailsLoading(true);
    setGuardrailsError(null);
    try {
      const response = await api.getLockedGuardrails();
      setGuardrails(response.guardrails);
    } catch (reason) {
      setGuardrailsError(operationError(reason, copyRef.current.guardrailsFailed).message);
    } finally {
      setGuardrailsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadDirectory();
    void loadGuardrails();
    return () => {
      directoryRequest.current += 1;
      profileRequest.current += 1;
    };
  }, [loadDirectory, loadGuardrails]);

  useEffect(() => {
    if (creating || directoryLoading || profiles.length === 0) return;
    if (profiles.some((candidate) => candidate.profileId === selectedProfileId)) return;
    setSelectedProfileId(preferredProfile(profiles)?.profileId ?? null);
  }, [creating, directoryLoading, profiles, selectedProfileId]);

  const loadSelectedProfile = useCallback(async (): Promise<void> => {
    if (selectedProfileId === null || creating) return;
    const request = ++profileRequest.current;
    setProfileLoading(true);
    setProfileError(null);
    setOperationErrorState(null);
    try {
      const response = await api.getProfile(selectedProfileId);
      if (request !== profileRequest.current) return;
      const content = contentFromProfile(response.profile);
      setProfile(response.profile);
      setDraft(content);
      setBaseline(contentFromProfile(response.profile));
    } catch (reason) {
      if (request !== profileRequest.current) return;
      setProfile(null);
      setDraft(null);
      setBaseline(null);
      setProfileError(operationError(reason, copyRef.current.profileFailed).message);
    } finally {
      if (request === profileRequest.current) setProfileLoading(false);
    }
  }, [api, creating, selectedProfileId]);

  useEffect(() => {
    void loadSelectedProfile();
  }, [loadSelectedProfile]);

  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [dirty]);

  const canDiscard = useCallback((): boolean => {
    return !dirty || window.confirm(copy.discardConfirm);
  }, [dirty, copy.discardConfirm]);

  const selectProfile = (profileId: string): void => {
    if (profileId === selectedProfileId && !creating) return;
    if (!canDiscard()) return;
    profileRequest.current += 1;
    setCreating(false);
    setSelectedProfileId(profileId);
    setProfile(null);
    setDraft(null);
    setBaseline(null);
    setOperationErrorState(null);
  };

  const beginCreate = (): void => {
    if (!canDiscard()) return;
    profileRequest.current += 1;
    setCreating(true);
    setSelectedProfileId(null);
    setProfile(null);
    const content = starterProfileContent();
    setDraft(content);
    setBaseline(null);
    setProfileError(null);
    setOperationErrorState(null);
  };

  const discard = (): void => {
    setDraftReset((previous) => previous + 1);
    setOperationErrorState(null);
    if (creating) {
      setCreating(false);
      setDraft(null);
      setBaseline(null);
      setSelectedProfileId(preferredProfile(profiles)?.profileId ?? null);
      return;
    }
    if (baseline !== null) setDraft(structuredClone(baseline));
  };

  const save = useCallback(async (): Promise<void> => {
    if (draft === null || validation === null || !validation.valid || validation.content === null) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setBusy('save');
    setOperationErrorState(null);
    try {
      const saved = await saveProfile(
        api,
        validation.content,
        profile === null ? null : { profileId: profile.profileId, updatedAt: profile.updatedAt },
      );
      const content = contentFromProfile(saved);
      setProfile(saved);
      setDraft(content);
      setBaseline(contentFromProfile(saved));
      setCreating(false);
      setSelectedProfileId(saved.profileId);
      await loadDirectory();
    } catch (reason) {
      setOperationErrorState(operationError(reason, copyRef.current.saveFailed));
    } finally {
      setBusy(null);
    }
  }, [api, draft, loadDirectory, profile, validation]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        if (view === 'profiles' && busy === null && activeDialog === null) void save();
      }
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  }, [activeDialog, busy, save, view]);

  const exportCurrent = async (): Promise<void> => {
    if (profile === null) return;
    setBusy('export');
    setOperationErrorState(null);
    try {
      downloadJsonArtifact(await api.exportProfile(profile.profileId));
    } catch (reason) {
      setOperationErrorState(operationError(reason, copyRef.current.exportFailed));
    } finally {
      setBusy(null);
    }
  };

  const duplicateCurrent = async (target: EvaluationProfile, name: string): Promise<void> => {
    setBusy('duplicate');
    setDialogError(null);
    try {
      const duplicated = (await api.duplicateProfile(target.profileId, { name })).profile;
      setActiveDialog(null);
      const content = contentFromProfile(duplicated);
      setProfile(duplicated);
      setDraft(content);
      setBaseline(contentFromProfile(duplicated));
      setSelectedProfileId(duplicated.profileId);
      await loadDirectory();
    } catch (reason) {
      setDialogError(operationError(reason, copyRef.current.duplicateFailed).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteCurrent = async (target: EvaluationProfile): Promise<void> => {
    if (target.isDefault) return;
    setBusy('delete');
    setDialogError(null);
    try {
      await api.deleteProfile(target.profileId, target.updatedAt);
      setActiveDialog(null);
      setProfile(null);
      setDraft(null);
      setBaseline(null);
      setSelectedProfileId(null);
      const nextProfiles = await loadDirectory();
      setSelectedProfileId(preferredProfile(nextProfiles ?? [])?.profileId ?? null);
    } catch (reason) {
      setDialogError(operationError(reason, copyRef.current.deleteFailed).message);
    } finally {
      setBusy(null);
    }
  };

  const imported = (nextProfile: EvaluationProfile): void => {
    const content = contentFromProfile(nextProfile);
    setDraftReset((previous) => previous + 1);
    setActiveDialog(null);
    setProfile(nextProfile);
    setDraft(content);
    setBaseline(contentFromProfile(nextProfile));
    setCreating(false);
    setSelectedProfileId(nextProfile.profileId);
    setOperationErrorState(null);
    void loadDirectory();
  };

  const openProtected = (open: () => void): void => {
    if (!canDiscard()) return;
    setDialogError(null);
    open();
  };

  const selectView = (nextView: 'profiles' | 'evaluation'): void => {
    if (nextView === 'evaluation' && !canDiscard()) return;
    if (nextView === 'evaluation' && dirty) discard();
    setView(nextView);
    writeStudioView(nextView);
  };

  return (
    <div className="studio-shell">
      <header className="studio-app-header">
        <div className="studio-brand">
          <span className="studio-brand-mark" aria-hidden="true">
            E
          </span>
          <h1>Evaluation Studio</h1>
        </div>
        <div className="studio-header-actions">
          <LanguageSwitcher />
          {view === 'profiles' ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => selectView('evaluation')}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {copy.evaluations}
            </button>
          ) : null}
          <button
            className="icon-button studio-profile-button"
            type="button"
            aria-label={copy.profileSelect}
            title={copy.profile}
            aria-haspopup="dialog"
            aria-expanded={profileMenuOpen}
            disabled={busy !== null}
            onClick={() => setProfileMenuOpen(true)}
          >
            <UserRound size={21} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="studio-main">
        {view === 'evaluation' ? (
          <EvaluationWorkspace
            api={api}
            profiles={profiles}
            profilesLoading={directoryLoading}
            profileDirectoryError={directoryError}
            dirtyProfile={dirty}
            selectedProfileId={selectedProfileId}
          />
        ) : (
          <>
            <StudioToolbar
              profile={profile}
              creating={creating}
              dirty={dirty}
              valid={validation?.valid ?? false}
              busy={busy}
              onSave={() => void save()}
              onDiscard={discard}
              onCreate={beginCreate}
              onImport={() =>
                openProtected(() =>
                  setActiveDialog({
                    kind: 'import',
                    replaceTarget: captureImportReplaceTarget(profile),
                  }),
                )
              }
              onExport={() => void exportCurrent()}
              onDuplicate={() =>
                openProtected(() => {
                  if (profile !== null) {
                    setActiveDialog({ kind: 'duplicate', profile: structuredClone(profile) });
                  }
                })
              }
              onDelete={() =>
                openProtected(() => {
                  if (profile !== null) {
                    setActiveDialog({ kind: 'delete', profile: structuredClone(profile) });
                  }
                })
              }
            />

            {directoryError === null ? null : (
              <StatusBanner tone="error" title={copy.profileServiceUnavailable}>
                <p>{directoryError}</p>
                <button type="button" onClick={() => void loadDirectory()}>
                  <RefreshCw aria-hidden="true" size={14} /> {copy.reload}
                </button>
              </StatusBanner>
            )}
            {operationErrorState === null ? null : (
              <OperationErrorBanner
                error={operationErrorState}
                onReload={() => {
                  if (operationErrorState.conflict && window.confirm(copy.reloadConfirm)) {
                    void loadSelectedProfile();
                  }
                }}
                onDismiss={() => setOperationErrorState(null)}
              />
            )}

            {profileLoading ? <WorkspaceState loading title={copy.loadingProfile} /> : null}
            {!profileLoading && profileError !== null ? (
              <WorkspaceState
                title={copy.profileUnavailable}
                detail={profileError}
                action={copy.reload}
                onAction={() => void loadSelectedProfile()}
              />
            ) : null}
            {!profileLoading && profileError === null && draft !== null && validation !== null ? (
              <div className="workspace-content">
                <ProfileEditor
                  key={`${profile?.profileId ?? 'new-profile'}:${String(draftReset)}`}
                  content={draft}
                  validation={validation}
                  disabled={busy !== null}
                  onChange={setDraft}
                />
                <GuardrailsPanel
                  guardrails={guardrails}
                  loading={guardrailsLoading}
                  error={guardrailsError}
                  onRetry={() => void loadGuardrails()}
                />
              </div>
            ) : null}
            {!profileLoading && profileError === null && draft === null ? (
              <WorkspaceState
                title={profiles.length === 0 ? copy.noProfile : copy.selectProfile}
                detail={profiles.length === 0 ? copy.firstProfileHint : copy.selectProfileHint}
                action={copy.newProfile}
                onAction={beginCreate}
              />
            ) : null}
          </>
        )}
      </main>

      {profileMenuOpen ? (
        <ProfileMenu
          profiles={profiles}
          selectedProfileId={creating ? null : selectedProfileId}
          search={search}
          loading={directoryLoading}
          disabled={disabled}
          error={directoryError}
          onSearch={setSearch}
          onSelect={(id) => {
            selectProfile(id);
            setProfileMenuOpen(false);
          }}
          onManage={() => {
            setProfileMenuOpen(false);
            selectView('profiles');
          }}
          onCreate={() => {
            setProfileMenuOpen(false);
            beginCreate();
            selectView('profiles');
          }}
          onClose={() => setProfileMenuOpen(false)}
        />
      ) : null}

      {activeDialog?.kind === 'import' ? (
        <ImportDialog
          api={api}
          replaceTarget={activeDialog.replaceTarget}
          onImported={imported}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}
      {activeDialog?.kind === 'duplicate' ? (
        <DuplicateProfileDialog
          profile={activeDialog.profile}
          busy={busy === 'duplicate'}
          error={dialogError}
          onConfirm={(name) => void duplicateCurrent(activeDialog.profile, name)}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}
      {activeDialog?.kind === 'delete' ? (
        <DeleteProfileDialog
          profile={activeDialog.profile}
          busy={busy === 'delete'}
          error={dialogError}
          onConfirm={() => void deleteCurrent(activeDialog.profile)}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}
    </div>
  );
}

function StudioToolbar({
  profile,
  creating,
  dirty,
  valid,
  busy,
  onSave,
  onDiscard,
  onCreate,
  onImport,
  onExport,
  onDuplicate,
  onDelete,
}: {
  readonly profile: EvaluationProfile | null;
  readonly creating: boolean;
  readonly dirty: boolean;
  readonly valid: boolean;
  readonly busy: BusyOperation;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCreate: () => void;
  readonly onImport: () => void;
  readonly onExport: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const copy = studioAppCopy(useI18n().locale);
  return (
    <header className="studio-toolbar">
      <div className="toolbar-title">
        <span className="eyebrow">
          {creating ? copy.newDraft : profile?.isDefault ? copy.defaultProfile : copy.profile}
        </span>
        <h2>{creating ? copy.newProfile : (profile?.name ?? copy.profileManagement)}</h2>
        {profile === null ? null : <code title={profile.profileId}>{profile.profileId}</code>}
      </div>
      <div className="toolbar-status" role="status">
        {busy !== null ? (
          <LoaderCircle className="spin" aria-hidden="true" size={14} />
        ) : dirty ? (
          <span className="dirty-dot" />
        ) : (
          <Check aria-hidden="true" size={14} />
        )}
        {busy !== null
          ? copy.processing
          : dirty
            ? valid
              ? copy.unsaved
              : copy.invalidDraft
            : copy.saved}
      </div>
      <div className="toolbar-actions">
        <button
          className="icon-button"
          type="button"
          title={copy.newProfile}
          aria-label={copy.newProfile}
          disabled={busy !== null}
          onClick={onCreate}
        >
          <Plus aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          title={copy.importProfile}
          aria-label={copy.importProfile}
          disabled={busy !== null}
          onClick={onImport}
        >
          <FileUp aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          title={copy.exportJson}
          aria-label={copy.exportJson}
          disabled={busy !== null || profile === null || dirty}
          onClick={onExport}
        >
          {busy === 'export' ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <FileDown aria-hidden="true" size={16} />
          )}
        </button>
        <button
          className="icon-button"
          type="button"
          title={copy.duplicateProfile}
          aria-label={copy.duplicateProfile}
          disabled={busy !== null || profile === null || dirty}
          onClick={onDuplicate}
        >
          <Copy aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button danger-icon"
          type="button"
          title={profile?.isDefault ? copy.defaultCannotDelete : copy.deleteProfile}
          aria-label={copy.deleteProfile}
          disabled={busy !== null || profile === null || profile.isDefault || dirty}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" size={16} />
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          className="secondary-button"
          type="button"
          disabled={busy !== null || !dirty}
          onClick={onDiscard}
        >
          <RotateCcw aria-hidden="true" size={15} /> {copy.discard}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={busy !== null || !dirty || !valid}
          onClick={onSave}
        >
          {busy === 'save' ? (
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
          ) : (
            <Save aria-hidden="true" size={15} />
          )}
          {copy.save}
        </button>
      </div>
    </header>
  );
}

function OperationErrorBanner({
  error,
  onReload,
  onDismiss,
}: {
  readonly error: StudioOperationError;
  readonly onReload: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const copy = studioAppCopy(useI18n().locale);
  return (
    <StatusBanner
      tone={error.conflict ? 'conflict' : 'error'}
      title={error.conflict ? copy.versionConflict : copy.actionFailed}
    >
      <p>{error.message}</p>
      {error.fieldErrors.length === 0 ? null : (
        <ul>
          {error.fieldErrors.map((field, index) => (
            <li key={`${field.path.join('.')}:${String(index)}`}>
              {field.path.join(' / ')}: {field.message}
            </li>
          ))}
        </ul>
      )}
      <div>
        {error.conflict ? (
          <button type="button" onClick={onReload}>
            <RefreshCw aria-hidden="true" size={14} /> {copy.loadServer}
          </button>
        ) : null}
        <button type="button" onClick={onDismiss}>
          {copy.continueEditing}
        </button>
      </div>
    </StatusBanner>
  );
}

function StatusBanner({
  tone,
  title,
  children,
}: {
  readonly tone: 'error' | 'conflict';
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={`status-banner is-${tone}`} role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </section>
  );
}

function WorkspaceState({
  title,
  detail,
  loading = false,
  action,
  onAction,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly loading?: boolean;
  readonly action?: string;
  readonly onAction?: () => void;
}): ReactNode {
  return (
    <section className="workspace-state" aria-live="polite" aria-busy={loading}>
      {loading ? (
        <LoaderCircle className="spin" aria-hidden="true" size={24} />
      ) : (
        <Download aria-hidden="true" size={24} />
      )}
      <h2>{title}</h2>
      {detail === undefined ? null : <p>{detail}</p>}
      {action === undefined || onAction === undefined ? null : (
        <button className="primary-button" type="button" onClick={onAction}>
          <Plus aria-hidden="true" size={15} />
          {action}
        </button>
      )}
    </section>
  );
}

function preferredProfile(
  profiles: readonly EvaluationProfileSummary[],
): EvaluationProfileSummary | null {
  return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
}

export function readStudioView(): 'profiles' | 'evaluation' {
  if (typeof window === 'undefined') return 'evaluation';
  const value = new URL(window.location.href).searchParams.get('view');
  return studioViewFromQuery(value);
}

export function studioViewFromQuery(value: string | null): 'profiles' | 'evaluation' {
  return value === 'profiles' ? 'profiles' : 'evaluation';
}

function writeStudioView(view: 'profiles' | 'evaluation'): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (view === 'evaluation') url.searchParams.delete('view');
  else url.searchParams.set('view', 'profiles');
  window.history.replaceState(window.history.state, '', url);
}

function readProfileSelection(): string | null {
  return typeof window === 'undefined'
    ? null
    : new URL(window.location.href).searchParams.get('profileId');
}
