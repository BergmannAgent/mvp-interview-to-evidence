import type { GuideParseIssue } from '@orgscience/domain';

import type { RepositoryError, Result } from './persistence/index.js';

export interface GuideInvalidError {
  readonly code: 'guide_invalid';
  readonly issues: readonly GuideParseIssue[];
}

export interface ApplicationValidationError {
  readonly code: 'application_validation';
  readonly field: string;
  readonly message: string;
}

export interface ApplicationInvariantError {
  readonly code: 'application_invariant';
  readonly resource:
    'guide' | 'interview_view' | 'interview_summary' | 'monitoring_snapshot' | 'monitoring_stream';
  readonly id: string;
  readonly message: string;
}

export interface RuntimeDependencyError {
  readonly code: 'runtime_dependency_invalid';
  readonly dependency: 'clock' | 'sha256';
  readonly message: string;
}

export interface MonitoringCursorAheadError {
  readonly code: 'monitoring_cursor_ahead';
  readonly interviewId: string;
  readonly cursor: number;
  readonly highWaterSequence: number;
}

export interface MonitoringCursorStaleError {
  readonly code: 'monitoring_cursor_stale';
  readonly interviewId: string;
  readonly cursor: number;
  readonly highWaterSequence: number;
  readonly maximumReplayEvents: number;
}

export type ApplicationError =
  | RepositoryError
  | GuideInvalidError
  | ApplicationValidationError
  | ApplicationInvariantError
  | MonitoringCursorAheadError
  | MonitoringCursorStaleError
  | RuntimeDependencyError;

export type ApplicationResult<T> = Result<T, ApplicationError>;
