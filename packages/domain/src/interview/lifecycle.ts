export type InterviewTimestamp = string;

export interface InterviewFailure {
  readonly code: string;
  readonly message: string;
}

interface InterviewStateBase {
  readonly interviewId: string;
  readonly guideId: string;
  readonly createdAt: InterviewTimestamp;
  readonly revision: number;
}

export interface ReadyInterviewState extends InterviewStateBase {
  readonly status: 'ready';
}

export interface ActiveInterviewState extends InterviewStateBase {
  readonly status: 'active';
  readonly startedAt: InterviewTimestamp;
  readonly activeSince: InterviewTimestamp;
}

export interface PausedInterviewState extends InterviewStateBase {
  readonly status: 'paused';
  readonly startedAt: InterviewTimestamp;
  readonly pausedAt: InterviewTimestamp;
}

export interface EndingInterviewState extends InterviewStateBase {
  readonly status: 'ending';
  readonly startedAt: InterviewTimestamp;
  readonly endingAt: InterviewTimestamp;
  readonly endingFrom: 'active' | 'paused';
}

export interface CompletedInterviewState extends InterviewStateBase {
  readonly status: 'completed';
  readonly startedAt: InterviewTimestamp;
  readonly endingAt: InterviewTimestamp;
  readonly endedAt: InterviewTimestamp;
}

export interface FailedInterviewState extends InterviewStateBase {
  readonly status: 'failed';
  readonly startedAt: InterviewTimestamp | null;
  readonly failedAt: InterviewTimestamp;
  readonly failedFrom: 'ready' | 'active' | 'paused' | 'ending';
  readonly failure: InterviewFailure;
}

export type InterviewLifecycleState =
  | ReadyInterviewState
  | ActiveInterviewState
  | PausedInterviewState
  | EndingInterviewState
  | CompletedInterviewState
  | FailedInterviewState;

export type InterviewLifecycleAction =
  | { readonly type: 'start'; readonly at: InterviewTimestamp }
  | { readonly type: 'pause'; readonly at: InterviewTimestamp }
  | { readonly type: 'resume'; readonly at: InterviewTimestamp }
  | { readonly type: 'begin_ending'; readonly at: InterviewTimestamp }
  | { readonly type: 'complete'; readonly at: InterviewTimestamp }
  | {
      readonly type: 'fail';
      readonly at: InterviewTimestamp;
      readonly failure: InterviewFailure;
    };

export type InterviewLifecycleActionType = InterviewLifecycleAction['type'];

export type InterviewTransitionErrorCode =
  'invalid_transition' | 'invalid_timestamp' | 'timestamp_regression' | 'invalid_failure';

export interface InterviewTransitionError {
  readonly code: InterviewTransitionErrorCode;
  readonly message: string;
  readonly currentStatus: InterviewLifecycleState['status'];
  readonly attemptedAction: InterviewLifecycleActionType;
  readonly allowedActions: readonly InterviewLifecycleActionType[];
}

export type InterviewTransitionResult =
  | { readonly ok: true; readonly state: InterviewLifecycleState }
  | { readonly ok: false; readonly error: InterviewTransitionError };

export interface CreateReadyInterviewInput {
  readonly interviewId: string;
  readonly guideId: string;
  readonly createdAt: InterviewTimestamp;
}

export type InterviewLifecycleSnapshot =
  | { readonly status: 'ready' }
  | {
      readonly status: 'active';
      readonly startedAt: InterviewTimestamp;
      readonly activeSince: InterviewTimestamp;
    }
  | {
      readonly status: 'paused';
      readonly startedAt: InterviewTimestamp;
      readonly pausedAt: InterviewTimestamp;
    }
  | {
      readonly status: 'ending';
      readonly startedAt: InterviewTimestamp;
      readonly endingAt: InterviewTimestamp;
      readonly endingFrom: 'active' | 'paused';
    }
  | {
      readonly status: 'completed';
      readonly startedAt: InterviewTimestamp;
      readonly endingAt: InterviewTimestamp;
      readonly endedAt: InterviewTimestamp;
    }
  | {
      readonly status: 'failed';
      readonly startedAt: InterviewTimestamp | null;
      readonly failedAt: InterviewTimestamp;
      readonly failedFrom: 'ready' | 'active' | 'paused' | 'ending';
      readonly failure: InterviewFailure;
    };

const ALLOWED_ACTIONS: Readonly<
  Record<InterviewLifecycleState['status'], readonly InterviewLifecycleActionType[]>
> = {
  ready: ['start', 'fail'],
  active: ['pause', 'begin_ending', 'fail'],
  paused: ['resume', 'begin_ending', 'fail'],
  ending: ['complete', 'fail'],
  completed: [],
  failed: [],
};

export function createReadyInterview(input: CreateReadyInterviewInput): ReadyInterviewState {
  assertNonEmptyIdentifier(input.interviewId, 'interviewId');
  assertNonEmptyIdentifier(input.guideId, 'guideId');
  if (!isValidTimestamp(input.createdAt)) {
    throw new TypeError('createdAt must be a valid timestamp');
  }

  return {
    status: 'ready',
    interviewId: input.interviewId,
    guideId: input.guideId,
    createdAt: input.createdAt,
    revision: 0,
  };
}

export function getAllowedLifecycleActions(
  state: InterviewLifecycleState,
): readonly InterviewLifecycleActionType[] {
  return ALLOWED_ACTIONS[state.status];
}

export function toInterviewLifecycleSnapshot(
  state: InterviewLifecycleState,
): InterviewLifecycleSnapshot {
  switch (state.status) {
    case 'ready':
      return { status: state.status };
    case 'active':
      return {
        status: state.status,
        startedAt: state.startedAt,
        activeSince: state.activeSince,
      };
    case 'paused':
      return {
        status: state.status,
        startedAt: state.startedAt,
        pausedAt: state.pausedAt,
      };
    case 'ending':
      return {
        status: state.status,
        startedAt: state.startedAt,
        endingAt: state.endingAt,
        endingFrom: state.endingFrom,
      };
    case 'completed':
      return {
        status: state.status,
        startedAt: state.startedAt,
        endingAt: state.endingAt,
        endedAt: state.endedAt,
      };
    case 'failed':
      return {
        status: state.status,
        startedAt: state.startedAt,
        failedAt: state.failedAt,
        failedFrom: state.failedFrom,
        failure: state.failure,
      };
    default:
      return assertNever(state);
  }
}

export function transitionInterview(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
): InterviewTransitionResult {
  const allowedActions = getAllowedLifecycleActions(state);
  if (!allowedActions.includes(action.type)) {
    return transitionFailure(
      state,
      action,
      'invalid_transition',
      `Cannot ${action.type} an interview in the ${state.status} state`,
    );
  }

  if (!isValidTimestamp(action.at)) {
    return transitionFailure(
      state,
      action,
      'invalid_timestamp',
      `${action.type} requires a valid timestamp`,
    );
  }

  if (Date.parse(action.at) < Date.parse(latestTransitionTimestamp(state))) {
    return transitionFailure(
      state,
      action,
      'timestamp_regression',
      `${action.type} cannot occur before the previous lifecycle transition`,
    );
  }

  if (action.type === 'fail' && !isValidFailure(action.failure)) {
    return transitionFailure(
      state,
      action,
      'invalid_failure',
      'A failure requires a non-empty code and message',
    );
  }

  return applyAllowedTransition(state, action);
}

function applyAllowedTransition(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
): InterviewTransitionResult {
  switch (action.type) {
    case 'start':
      if (state.status !== 'ready') {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'active',
          startedAt: action.at,
          activeSince: action.at,
        },
      };
    case 'pause':
      if (state.status !== 'active') {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'paused',
          startedAt: state.startedAt,
          pausedAt: action.at,
        },
      };
    case 'resume':
      if (state.status !== 'paused') {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'active',
          startedAt: state.startedAt,
          activeSince: action.at,
        },
      };
    case 'begin_ending':
      if (state.status !== 'active' && state.status !== 'paused') {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'ending',
          startedAt: state.startedAt,
          endingAt: action.at,
          endingFrom: state.status,
        },
      };
    case 'complete':
      if (state.status !== 'ending') {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'completed',
          startedAt: state.startedAt,
          endingAt: state.endingAt,
          endedAt: action.at,
        },
      };
    case 'fail':
      if (
        state.status !== 'ready' &&
        state.status !== 'active' &&
        state.status !== 'paused' &&
        state.status !== 'ending'
      ) {
        return invalidTransitionAfterNarrowing(state, action);
      }
      return {
        ok: true,
        state: {
          ...baseForNextRevision(state),
          status: 'failed',
          startedAt: state.status === 'ready' ? null : state.startedAt,
          failedAt: action.at,
          failedFrom: state.status,
          failure: action.failure,
        },
      };
    default:
      return assertNever(action);
  }
}

function baseForNextRevision(state: InterviewLifecycleState): InterviewStateBase {
  return {
    interviewId: state.interviewId,
    guideId: state.guideId,
    createdAt: state.createdAt,
    revision: state.revision + 1,
  };
}

function latestTransitionTimestamp(state: InterviewLifecycleState): InterviewTimestamp {
  switch (state.status) {
    case 'ready':
      return state.createdAt;
    case 'active':
      return state.activeSince;
    case 'paused':
      return state.pausedAt;
    case 'ending':
      return state.endingAt;
    case 'completed':
      return state.endedAt;
    case 'failed':
      return state.failedAt;
    default:
      return assertNever(state);
  }
}

function invalidTransitionAfterNarrowing(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
): InterviewTransitionResult {
  return transitionFailure(
    state,
    action,
    'invalid_transition',
    `Cannot ${action.type} an interview in the ${state.status} state`,
  );
}

function transitionFailure(
  state: InterviewLifecycleState,
  action: InterviewLifecycleAction,
  code: InterviewTransitionErrorCode,
  message: string,
): InterviewTransitionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      currentStatus: state.status,
      attemptedAction: action.type,
      allowedActions: getAllowedLifecycleActions(state),
    },
  };
}

function isValidFailure(failure: InterviewFailure): boolean {
  return failure.code.trim().length > 0 && failure.message.trim().length > 0;
}

function isValidTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function assertNonEmptyIdentifier(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lifecycle variant: ${JSON.stringify(value)}`);
}
