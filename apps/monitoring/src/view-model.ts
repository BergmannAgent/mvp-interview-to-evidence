import type {
  AgentName,
  GuideQuestionReference,
  GuideStructure,
  InterviewStatus,
  MonitoringEvent,
  QuestionCoverageStatus,
  RunStatus,
  SupportedLocale,
  StructuredAgentOutput,
  VoiceState,
  WorkflowStepName,
} from '@orgscience/contracts';
import {
  formatDateTime as formatLocalizedDateTime,
  formatNumber,
  type MessageKey,
  type Translate,
} from '@orgscience/frontend-i18n';

export interface QuestionView {
  readonly id: string;
  readonly text: string;
  readonly sectionTitle: string;
  readonly mainQuestionText: string;
}

export const agentNames: readonly AgentName[] = [
  'coverage_analysis',
  'consistency_analysis',
  'interview_decision',
  'interview_conductor',
  'transcript_finalization',
];

export const workflowSteps: readonly WorkflowStepName[] = [
  'receive_user_turn',
  'finalize_user_turn',
  'load_interview_state',
  'coverage_analysis',
  'consistency_analysis',
  'interview_decision',
  'conductor_question_generation',
  'validation',
  'persistence',
  'text_streaming',
  'audio_streaming',
  'state_update',
];

const agentLabelKeys: Record<AgentName, MessageKey> = {
  coverage_analysis: 'monitoring.agent.label.coverage_analysis',
  consistency_analysis: 'monitoring.agent.label.consistency_analysis',
  interview_decision: 'monitoring.agent.label.interview_decision',
  interview_conductor: 'monitoring.agent.label.interview_conductor',
  transcript_finalization: 'monitoring.agent.label.transcript_finalization',
};

const agentTaskKeys: Record<AgentName, MessageKey> = {
  coverage_analysis: 'monitoring.agent.task.coverage_analysis',
  consistency_analysis: 'monitoring.agent.task.consistency_analysis',
  interview_decision: 'monitoring.agent.task.interview_decision',
  interview_conductor: 'monitoring.agent.task.interview_conductor',
  transcript_finalization: 'monitoring.agent.task.transcript_finalization',
};

const workflowStepKeys: Record<WorkflowStepName, MessageKey> = {
  receive_user_turn: 'monitoring.workflow.step.receive_user_turn',
  finalize_user_turn: 'monitoring.workflow.step.finalize_user_turn',
  load_interview_state: 'monitoring.workflow.step.load_interview_state',
  coverage_analysis: 'monitoring.workflow.step.coverage_analysis',
  consistency_analysis: 'monitoring.workflow.step.consistency_analysis',
  interview_decision: 'monitoring.workflow.step.interview_decision',
  conductor_question_generation: 'monitoring.workflow.step.conductor_question_generation',
  validation: 'monitoring.workflow.step.validation',
  persistence: 'monitoring.workflow.step.persistence',
  text_streaming: 'monitoring.workflow.step.text_streaming',
  audio_streaming: 'monitoring.workflow.step.audio_streaming',
  state_update: 'monitoring.workflow.step.state_update',
};

const runStatusKeys: Record<RunStatus, MessageKey> = {
  waiting: 'monitoring.runStatus.waiting',
  running: 'monitoring.runStatus.running',
  succeeded: 'monitoring.runStatus.succeeded',
  failed: 'monitoring.runStatus.failed',
  retrying: 'monitoring.runStatus.retrying',
  skipped: 'monitoring.runStatus.skipped',
};

const coverageStatusKeys: Record<QuestionCoverageStatus, MessageKey> = {
  not_addressed: 'monitoring.coverageStatus.not_addressed',
  current: 'monitoring.coverageStatus.current',
  partially_answered: 'monitoring.coverageStatus.partially_answered',
  answered: 'monitoring.coverageStatus.answered',
  skipped_already_answered: 'monitoring.coverageStatus.skipped_already_answered',
};

const interviewStatusKeys: Record<InterviewStatus, MessageKey> = {
  ready: 'monitoring.status.ready',
  active: 'monitoring.status.active',
  paused: 'monitoring.status.paused',
  ending: 'monitoring.status.ending',
  completed: 'monitoring.status.completed',
  failed: 'monitoring.status.failed',
};

const voiceStateKeys: Record<VoiceState, MessageKey> = {
  idle: 'monitoring.voiceState.idle',
  listening: 'monitoring.voiceState.listening',
  processing: 'monitoring.voiceState.processing',
  speaking: 'monitoring.voiceState.speaking',
  interrupted: 'monitoring.voiceState.interrupted',
  failed: 'monitoring.voiceState.failed',
};

export function buildQuestionIndex(guide: GuideStructure): ReadonlyMap<string, QuestionView> {
  const result = new Map<string, QuestionView>();
  for (const section of guide.sections) {
    for (const mainQuestion of section.mainQuestions) {
      result.set(mainQuestion.id, {
        id: mainQuestion.id,
        text: mainQuestion.text,
        sectionTitle: section.title,
        mainQuestionText: mainQuestion.text,
      });
      for (const followUp of mainQuestion.followUpQuestions) {
        result.set(followUp.id, {
          id: followUp.id,
          text: followUp.text,
          sectionTitle: section.title,
          mainQuestionText: mainQuestion.text,
        });
      }
    }
  }
  return result;
}

export function referenceQuestionId(reference: GuideQuestionReference): string {
  return reference.kind === 'main_question'
    ? reference.mainQuestionId
    : reference.followUpQuestionId;
}

export function agentLabel(t: Translate, name: AgentName): string {
  return t(agentLabelKeys[name]);
}

export function agentTask(t: Translate, name: AgentName): string {
  return t(agentTaskKeys[name]);
}

export function workflowStepLabel(t: Translate, step: WorkflowStepName): string {
  return t(workflowStepKeys[step]);
}

export function runStatusLabel(t: Translate, status: RunStatus): string {
  return t(runStatusKeys[status]);
}

export function coverageStatusLabel(t: Translate, status: QuestionCoverageStatus): string {
  return t(coverageStatusKeys[status]);
}

export function interviewStatusLabel(t: Translate, status: InterviewStatus): string {
  return t(interviewStatusKeys[status]);
}

export function voiceStateLabel(t: Translate, state: VoiceState): string {
  return t(voiceStateKeys[state]);
}

export function formatClock(locale: SupportedLocale, timestamp: string | null): string {
  return formatLocalizedDateTime(locale, timestamp, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDateTime(locale: SupportedLocale, timestamp: string | null): string {
  return formatLocalizedDateTime(locale, timestamp, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(
  locale: SupportedLocale,
  t: Translate,
  durationMs: number | null,
): string {
  if (durationMs === null) return t('common.value.notAvailable');
  if (durationMs < 1_000) {
    return t('monitoring.duration.milliseconds', { value: formatNumber(locale, durationMs) });
  }
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) {
    return t('monitoring.duration.seconds', { value: formatNumber(locale, seconds) });
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return t('monitoring.duration.minutes', {
      value: `${formatNumber(locale, minutes)}:${String(remainder).padStart(2, '0')}`,
    });
  }
  const hours = Math.floor(minutes / 60);
  return t('monitoring.duration.hours', {
    value: `${formatNumber(locale, hours)}:${String(minutes % 60).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`,
  });
}

export function truncateIdentifier(identifier: string | null, length = 12): string {
  if (identifier === null) return '–';
  return identifier.length <= length ? identifier : `${identifier.slice(0, length)}…`;
}

export function structuredRationale(output: StructuredAgentOutput | null): string | null {
  return output?.output.rationale ?? null;
}

export function eventSummary(
  locale: SupportedLocale,
  t: Translate,
  event: MonitoringEvent,
): string {
  switch (event.type) {
    case 'interview.status_changed':
      return t('monitoring.event.summary.statusChanged', {
        previous:
          event.payload.previousStatus === null
            ? t('monitoring.event.summary.newStatus')
            : interviewStatusLabel(t, event.payload.previousStatus),
        next: interviewStatusLabel(t, event.payload.nextStatus),
      });
    case 'interview.section_compacted':
      return t('monitoring.event.summary.sectionCompacted', {
        section: event.payload.sectionTitle,
      });
    case 'workflow.started':
      return t('monitoring.event.summary.workflowStarted');
    case 'workflow.completed':
      return t('monitoring.event.summary.workflowCompleted', {
        duration: formatDuration(locale, t, event.payload.durationMs),
      });
    case 'workflow.failed':
      return t('monitoring.event.summary.workflowFailed', { code: event.payload.errorCode });
    case 'workflow.step_started':
    case 'workflow.step_completed':
    case 'workflow.step_failed':
      return t('monitoring.event.summary.stepStatus', {
        step: workflowStepLabel(t, event.payload.step),
        status: runStatusLabel(t, event.payload.status),
      });
    case 'agent.started':
      return t('monitoring.event.summary.agentStarted', {
        agent: agentLabel(t, event.payload.run.agentName),
      });
    case 'agent.completed':
      return t('monitoring.event.summary.agentCompleted', {
        agent: agentLabel(t, event.payload.run.agentName),
      });
    case 'agent.failed':
      return t('monitoring.event.summary.agentFailed', {
        agent: agentLabel(t, event.payload.run.agentName),
        message: event.payload.message,
      });
    case 'transcript.partial_received':
      return t('monitoring.event.summary.partialTranscript', { text: event.payload.text });
    case 'transcript.final_received':
      return t('monitoring.event.summary.finalTranscript', { text: event.payload.text });
    case 'transcript.turn_persisted':
      return t('monitoring.event.summary.turnPersisted', {
        number: formatNumber(locale, event.payload.sequenceNumber),
      });
    case 'transcript.gap_persisted':
      return t('monitoring.event.summary.gapPersisted', {
        description: event.payload.description,
      });
    case 'transcript.finalized':
      return t('monitoring.event.summary.transcriptFinalized');
    case 'transcript.ai_text_stream_started':
      return t('monitoring.event.summary.aiStreamStarted');
    case 'transcript.ai_text_delta':
      return t('monitoring.event.summary.aiStreamSegment', {
        number: formatNumber(locale, event.payload.deltaSequenceNumber),
      });
    case 'transcript.ai_text_stream_completed':
      return t('monitoring.event.summary.aiStreamCompleted');
    case 'transcript.ai_text_stream_interrupted':
      return t('monitoring.event.summary.aiStreamInterrupted');
    case 'voice.state_changed':
    case 'voice.playback_started':
    case 'voice.playback_completed':
    case 'voice.playback_interrupted':
      return t('monitoring.event.summary.voiceTransition', {
        previous: voiceStateLabel(t, event.payload.previousState),
        next: voiceStateLabel(t, event.payload.nextState),
      });
    case 'error.occurred':
      return t('monitoring.event.summary.error', {
        source: eventSourceLabel(t, event.payload.source),
        message: event.payload.message,
      });
    case 'retry.scheduled':
    case 'retry.started':
    case 'retry.exhausted':
      return t('monitoring.event.summary.retry', {
        target: retryTargetLabel(t, event.payload.target),
        attempt: formatNumber(locale, event.payload.attempt),
        maximum: formatNumber(locale, event.payload.maximumAttempts),
      });
    case 'state.updated':
      return t('monitoring.event.summary.stateUpdated', {
        version: formatNumber(locale, event.payload.nextVersion),
      });
  }
}

function eventSourceLabel(
  t: Translate,
  source: Extract<MonitoringEvent, { type: 'error.occurred' }>['payload']['source'],
): string {
  const keys = {
    interview: 'monitoring.event.category.interview',
    workflow: 'monitoring.event.category.workflow',
    agent: 'monitoring.event.category.agent',
    transcript: 'monitoring.event.category.transcript',
    voice: 'monitoring.event.category.voice',
    storage: 'monitoring.event.source.storage',
  } as const satisfies Record<typeof source, MessageKey>;
  return t(keys[source]);
}

function retryTargetLabel(
  t: Translate,
  target: 'agent' | 'voice_provider' | 'workflow_step',
): string {
  const keys = {
    workflow_step: 'monitoring.event.retryTarget.workflow_step',
    agent: 'monitoring.event.retryTarget.agent',
    voice_provider: 'monitoring.event.retryTarget.voice_provider',
  } as const satisfies Record<'agent' | 'voice_provider' | 'workflow_step', MessageKey>;
  return t(keys[target]);
}

export function eventAgentName(event: MonitoringEvent): AgentName | null {
  switch (event.type) {
    case 'agent.started':
    case 'agent.completed':
    case 'agent.failed':
      return event.payload.run.agentName;
    default:
      return null;
  }
}
