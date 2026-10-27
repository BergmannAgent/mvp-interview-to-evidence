import type { EvaluableInterview } from '@orgscience/api-client';
import type { SupportedLocale } from '@orgscience/contracts';
import { ChevronDown, FileText, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { interviewDisplayName } from '../studio-api.js';
import { interviewActivityAt } from './EvaluationRunner.js';
import './InterviewManagement.css';

const DIRECTORY_COPY = {
  de: {
    title: 'Interviews mit Antworten',
    workspace: 'Arbeitsbereich',
    reload: 'Interviews neu laden',
    select: 'Interview auswählen',
    search: 'Interviews durchsuchen',
    loading: 'Interviews werden geladen.',
    empty: 'Noch keine Interviews mit gespeicherten Antworten.',
    noMatch: 'Keine passenden Interviews.',
    rename: 'Interview umbenennen',
    delete: 'Interview löschen',
    stopBeforeDelete:
      'Vor dem Löschen das Interview pausieren oder beenden; laufende Verarbeitung abwarten.',
    statuses: {
      ready: 'Nicht gestartet',
      active: 'Laufend',
      paused: 'Pausiert',
      ending: 'Wird beendet',
      completed: 'Beendet',
      failed: 'Abgebrochen',
    },
  },
  en: {
    title: 'Interviews with answers',
    workspace: 'Workspace',
    reload: 'Reload interviews',
    select: 'Select interview',
    search: 'Search interviews',
    loading: 'Loading interviews.',
    empty: 'No interviews with saved answers yet.',
    noMatch: 'No matching interviews.',
    rename: 'Rename interview',
    delete: 'Delete interview',
    stopBeforeDelete:
      'Pause or end the interview before deleting it; wait for any processing to finish.',
    statuses: {
      ready: 'Not started',
      active: 'In progress',
      paused: 'Paused',
      ending: 'Ending',
      completed: 'Ended',
      failed: 'Stopped with an error',
    },
  },
} as const;

export interface InterviewDirectoryProps {
  readonly interviews: readonly EvaluableInterview[];
  readonly interfaceLanguage?: SupportedLocale;
  readonly selectedInterviewId: string | null;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly managementDisabled?: boolean;
  readonly error: string | null;
  readonly onSelect: (interviewId: string) => void;
  readonly onReload: () => void;
  readonly onRename: (interview: EvaluableInterview) => void;
  readonly onDelete: (interview: EvaluableInterview) => void;
  readonly runningEvaluationInterviewId?: string | null;
}

export function filterInterviews(
  interviews: readonly EvaluableInterview[],
  search: string,
): readonly EvaluableInterview[] {
  const term = search.trim().toLocaleLowerCase();
  return interviews
    .filter((interview) =>
      `${interviewDisplayName(interview)} ${interview.session.guideTitle} ${interview.summary.interviewId}`
        .toLocaleLowerCase()
        .includes(term),
    )
    .toSorted((a, b) => Date.parse(interviewActivityAt(b)) - Date.parse(interviewActivityAt(a)));
}

export function InterviewDirectory({
  interviews,
  selectedInterviewId,
  loading,
  disabled,
  managementDisabled = false,
  error,
  onSelect,
  onReload,
  onRename,
  onDelete,
  runningEvaluationInterviewId = null,
  interfaceLanguage = 'de',
}: InterviewDirectoryProps): ReactNode {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(() => filterInterviews(interviews, search), [interviews, search]);
  const copy = DIRECTORY_COPY[interfaceLanguage];
  return (
    <aside className="interview-directory" aria-label={copy.title} data-expanded={expanded}>
      <header className="interview-directory-header">
        <div>
          <span className="eyebrow">{copy.workspace}</span>
          <h2>
            {copy.title} <span>{interviews.length}</span>
          </h2>
        </div>
        <button
          className="icon-button"
          type="button"
          title={copy.reload}
          aria-label={copy.reload}
          disabled={disabled || loading}
          onClick={onReload}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>
      <button
        className="directory-toggle secondary-button"
        type="button"
        aria-expanded={expanded}
        aria-controls="studio-interview-directory-body"
        onClick={() => setExpanded((current) => !current)}
      >
        {copy.select}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id="studio-interview-directory-body" className="interview-directory-body">
        <label className="search-field" htmlFor="studio-interview-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">{copy.search}</span>
          <input
            id="studio-interview-search"
            type="search"
            placeholder={copy.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {error === null ? null : (
          <p role="alert" className="directory-error">
            {error}
          </p>
        )}
        <nav className="interview-directory-list" aria-label={copy.select} aria-busy={loading}>
          {loading && interviews.length === 0 ? (
            <p className="sidebar-state">{copy.loading}</p>
          ) : null}
          {!loading && visible.length === 0 ? (
            <p className="sidebar-state">{interviews.length === 0 ? copy.empty : copy.noMatch}</p>
          ) : null}
          {visible.map((interview) => {
            const { summary, session } = interview;
            const name = interviewDisplayName(interview);
            const deleteBlocked = interviewDeletionBlocked(interview, runningEvaluationInterviewId);
            return (
              <div className="interview-directory-item" key={summary.interviewId}>
                <button
                  className="interview-directory-row"
                  type="button"
                  disabled={disabled}
                  aria-current={summary.interviewId === selectedInterviewId ? 'true' : undefined}
                  onClick={() => {
                    onSelect(summary.interviewId);
                    setExpanded(false);
                  }}
                >
                  <FileText size={17} aria-hidden="true" />
                  <span>
                    <strong>{name}</strong>
                    <small>
                      <time dateTime={interviewActivityAt({ summary, session })}>
                        {new Intl.DateTimeFormat(interfaceLanguage === 'en' ? 'en-GB' : 'de-DE', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(interviewActivityAt({ summary, session })))}
                      </time>
                      <span className="interview-language">{session.language.toUpperCase()}</span>
                      <span>{copy.statuses[summary.status]}</span>
                    </small>
                    <code title={summary.interviewId}>{summary.interviewId}</code>
                  </span>
                </button>
                <div className="interview-directory-actions">
                  <button
                    className="icon-button"
                    type="button"
                    title={copy.rename}
                    aria-label={`${copy.rename}: ${name}`}
                    disabled={disabled || managementDisabled}
                    onClick={() => onRename(interview)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <span title={deleteBlocked ? copy.stopBeforeDelete : undefined}>
                    <button
                      className="icon-button danger-icon"
                      type="button"
                      title={deleteBlocked ? copy.stopBeforeDelete : copy.delete}
                      aria-label={`${copy.delete}: ${name}`}
                      disabled={disabled || managementDisabled || deleteBlocked}
                      onClick={() => onDelete(interview)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

export function interviewDeletionBlocked(
  interview: EvaluableInterview,
  runningEvaluationInterviewId: string | null = null,
): boolean {
  return (
    interview.summary.status === 'active' ||
    interview.summary.status === 'ending' ||
    interview.summary.activeWorkflowRunId !== null ||
    interview.summary.interviewId === runningEvaluationInterviewId
  );
}
