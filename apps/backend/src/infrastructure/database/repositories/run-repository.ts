import {
  failure,
  success,
  type IdempotentWrite,
  type RepositoryResult,
  type RunRepository as RunRepositoryPort,
  type StoredAgentRun,
  type StoredStepCheckpoint,
  type StoredWorkflowAttempt,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import { validateRunReferences } from './run-repository-references.js';
import {
  FINISH_AGENT_SQL,
  FINISH_STEP_SQL,
  FINISH_WORKFLOW_SQL,
  INSERT_AGENT_SQL,
  INSERT_STEP_SQL,
  INSERT_WORKFLOW_SQL,
  LIST_AGENTS_SQL,
  LIST_INTERVIEW_AGENTS_SQL,
  LIST_INTERVIEW_STEPS_SQL,
  LIST_STEPS_SQL,
  LIST_WORKFLOWS_SQL,
  LOAD_AGENT_SQL,
  LOAD_STEP_SQL,
  LOAD_WORKFLOW_SQL,
} from './run-repository-sql.js';
import {
  agentFinishParameters,
  agentParameters,
  normalizeAgentRun,
  normalizeStepCheckpoint,
  normalizeWorkflowAttempt,
  parseAgentRows,
  parseIdentityRows,
  parseSingleAgent,
  parseSingleStep,
  parseSingleWorkflow,
  parseStepRows,
  parseWorkflowRows,
  sameAgentRun,
  sameStepCheckpoint,
  sameWorkflowAttempt,
  stepFinishParameters,
  stepParameters,
  workflowFinishParameters,
  workflowParameters,
} from './run-repository-values.js';
import {
  constraint,
  duplicate,
  agentNameForStep,
  isTerminal,
  validateAgent,
  validateStep,
  validateWorkflow,
} from './run-repository-validation.js';
import type { SqlExecutor } from './sql.js';

export class PostgresRunRepository implements RunRepositoryPort {
  public constructor(private readonly executor: SqlExecutor) {}

  public async loadWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<StoredWorkflowAttempt>> {
    try {
      const result = await this.executor.query(LOAD_WORKFLOW_SQL, [interviewId, workflowRunId]);
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'workflow_run', id: workflowRunId });
      }
      return parseSingleWorkflow(result.rows, result.rowCount, interviewId, workflowRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', workflowRunId);
    }
  }

  public async listForInterview(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredWorkflowAttempt[]>> {
    try {
      const result = await this.executor.query(LIST_WORKFLOWS_SQL, [interviewId]);
      return parseWorkflowRows(result.rows, result.rowCount, interviewId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', interviewId);
    }
  }

  public async loadStep(
    interviewId: string,
    stepRunId: string,
  ): Promise<RepositoryResult<StoredStepCheckpoint>> {
    try {
      const result = await this.executor.query(LOAD_STEP_SQL, [interviewId, stepRunId]);
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'workflow_run', id: stepRunId });
      }
      return parseSingleStep(result.rows, result.rowCount, interviewId, stepRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', stepRunId);
    }
  }

  public async listStepsForWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<readonly StoredStepCheckpoint[]>> {
    try {
      const result = await this.executor.query(LIST_STEPS_SQL, [interviewId, workflowRunId]);
      if (result.rowCount === 0) {
        const workflow = await this.loadWorkflow(interviewId, workflowRunId);
        return workflow.ok ? success([]) : workflow;
      }
      return parseStepRows(result.rows, result.rowCount, interviewId, workflowRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', workflowRunId);
    }
  }

  public async listStepsForInterview(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredStepCheckpoint[]>> {
    try {
      const result = await this.executor.query(LIST_INTERVIEW_STEPS_SQL, [interviewId]);
      return parseStepRows(result.rows, result.rowCount, interviewId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', interviewId);
    }
  }

  public async loadAgent(
    interviewId: string,
    agentRunId: string,
  ): Promise<RepositoryResult<StoredAgentRun>> {
    try {
      const result = await this.executor.query(LOAD_AGENT_SQL, [interviewId, agentRunId]);
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'agent_run', id: agentRunId });
      }
      return parseSingleAgent(result.rows, result.rowCount, interviewId, agentRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'agent_run', agentRunId);
    }
  }

  public async listAgentsForWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<readonly StoredAgentRun[]>> {
    try {
      const result = await this.executor.query(LIST_AGENTS_SQL, [interviewId, workflowRunId]);
      if (result.rowCount === 0) {
        const workflow = await this.loadWorkflow(interviewId, workflowRunId);
        return workflow.ok ? success([]) : workflow;
      }
      return parseAgentRows(result.rows, result.rowCount, interviewId, workflowRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'agent_run', workflowRunId);
    }
  }

  public async listAgentsForInterview(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredAgentRun[]>> {
    try {
      const result = await this.executor.query(LIST_INTERVIEW_AGENTS_SQL, [interviewId]);
      return parseAgentRows(result.rows, result.rowCount, interviewId);
    } catch (error: unknown) {
      return databaseFailure(error, 'agent_run', interviewId);
    }
  }

  public async startWorkflow(
    interviewId: string,
    run: StoredWorkflowAttempt,
  ): Promise<RepositoryResult<IdempotentWrite<StoredWorkflowAttempt>>> {
    const issue = validateWorkflow(interviewId, run);
    if (issue !== null) return constraint(issue);

    try {
      const inserted = await this.executor.query(INSERT_WORKFLOW_SQL, workflowParameters(run));
      const identity = parseIdentityRows(
        inserted.rows,
        inserted.rowCount,
        'workflow_run',
        run.workflowRunId,
      );
      if (!identity.ok) return identity;
      if (inserted.rowCount === 1 && identity.value[0]?.id === run.workflowRunId) {
        return success({ outcome: 'inserted', value: normalizeWorkflowAttempt(run) });
      }
      if (inserted.rowCount !== 0) {
        return failure(corruptData('workflow_run', run.workflowRunId, 'Unexpected insert count'));
      }
      const existing = await this.loadWorkflow(interviewId, run.workflowRunId);
      if (!existing.ok) return existing;
      return sameWorkflowAttempt(existing.value, run)
        ? success({ outcome: 'existing', value: existing.value })
        : duplicate('workflow_run', run.workflowRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', run.workflowRunId);
    }
  }

  public async finishWorkflow(
    interviewId: string,
    workflowRunId: string,
    expectedStatus: 'running',
    next: StoredWorkflowAttempt,
  ): Promise<RepositoryResult<StoredWorkflowAttempt>> {
    const issue = validateWorkflow(interviewId, next);
    if (issue !== null) return constraint(issue);
    if (next.workflowRunId !== workflowRunId || !isTerminal(next.status)) {
      return constraint('workflow_finish_shape');
    }

    try {
      const result = await this.executor.query(
        FINISH_WORKFLOW_SQL,
        workflowFinishParameters(next, expectedStatus),
      );
      if (result.rowCount === 1) {
        return parseSingleWorkflow(result.rows, result.rowCount, interviewId, workflowRunId);
      }
      if (result.rowCount !== 0) {
        return failure(corruptData('workflow_run', workflowRunId, 'Unexpected update count'));
      }
      const existing = await this.loadWorkflow(interviewId, workflowRunId);
      if (!existing.ok) return existing;
      return sameWorkflowAttempt(existing.value, next)
        ? existing
        : duplicate('workflow_run', workflowRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', workflowRunId);
    }
  }

  public async saveStepCheckpoint(
    interviewId: string,
    attemptId: string,
    checkpoint: StoredStepCheckpoint,
  ): Promise<RepositoryResult<IdempotentWrite<StoredStepCheckpoint>>> {
    const issue = validateStep(interviewId, attemptId, checkpoint);
    if (issue !== null) return constraint(issue);
    const expectedAgentName = agentNameForStep(checkpoint.step);
    const references = await validateRunReferences(
      this.executor,
      interviewId,
      checkpoint.referencedTranscriptTurnIds,
      checkpoint.referencedGuideQuestionIds,
      [],
      checkpoint.structuredOutput,
      checkpoint.agentRunId === null || expectedAgentName === null
        ? null
        : {
            agentRunId: checkpoint.agentRunId,
            workflowRunId: checkpoint.workflowRunId,
            agentName: expectedAgentName,
            requireSucceeded: checkpoint.status === 'succeeded',
            structuredOutput: checkpoint.structuredOutput,
          },
    );
    if (!references.ok) return references;

    try {
      const inserted = await this.executor.query(
        INSERT_STEP_SQL,
        stepParameters(checkpoint, attemptId),
      );
      const identity = parseIdentityRows(
        inserted.rows,
        inserted.rowCount,
        'workflow_run',
        checkpoint.stepRunId,
      );
      if (!identity.ok) return identity;
      if (inserted.rowCount === 1 && identity.value[0]?.id === checkpoint.stepRunId) {
        return success({ outcome: 'inserted', value: normalizeStepCheckpoint(checkpoint) });
      }
      if (inserted.rowCount !== 0) {
        return failure(corruptData('workflow_run', checkpoint.stepRunId, 'Unexpected step count'));
      }
      const existing = await this.loadStep(interviewId, checkpoint.stepRunId);
      if (!existing.ok) return existing;
      return sameStepCheckpoint(existing.value, checkpoint)
        ? success({ outcome: 'existing', value: existing.value })
        : duplicate('workflow_run', checkpoint.stepRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', checkpoint.stepRunId);
    }
  }

  public async finishStep(
    interviewId: string,
    stepRunId: string,
    expectedStatus: 'running',
    next: StoredStepCheckpoint,
  ): Promise<RepositoryResult<StoredStepCheckpoint>> {
    const issue = validateStep(interviewId, next.attemptId, next);
    if (issue !== null) return constraint(issue);
    if (next.stepRunId !== stepRunId || !isTerminal(next.status)) {
      return constraint('workflow_step_finish_shape');
    }
    const expectedAgentName = agentNameForStep(next.step);
    const references = await validateRunReferences(
      this.executor,
      interviewId,
      next.referencedTranscriptTurnIds,
      next.referencedGuideQuestionIds,
      [],
      next.structuredOutput,
      next.agentRunId === null || expectedAgentName === null
        ? null
        : {
            agentRunId: next.agentRunId,
            workflowRunId: next.workflowRunId,
            agentName: expectedAgentName,
            requireSucceeded: next.status === 'succeeded',
            structuredOutput: next.structuredOutput,
          },
    );
    if (!references.ok) return references;

    try {
      const result = await this.executor.query(
        FINISH_STEP_SQL,
        stepFinishParameters(next, expectedStatus),
      );
      if (result.rowCount === 1) {
        return parseSingleStep(result.rows, result.rowCount, interviewId, stepRunId);
      }
      if (result.rowCount !== 0) {
        return failure(corruptData('workflow_run', stepRunId, 'Unexpected step update count'));
      }
      const existing = await this.loadStep(interviewId, stepRunId);
      if (!existing.ok) return existing;
      return sameStepCheckpoint(existing.value, next)
        ? existing
        : duplicate('workflow_run', stepRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'workflow_run', stepRunId);
    }
  }

  public async startAgent(
    interviewId: string,
    run: StoredAgentRun,
  ): Promise<RepositoryResult<IdempotentWrite<StoredAgentRun>>> {
    const issue = validateAgent(interviewId, run);
    if (issue !== null) return constraint(issue);
    const references = await validateRunReferences(
      this.executor,
      interviewId,
      run.validatedInput.transcriptTurnIds,
      run.validatedInput.guideQuestionIds,
      run.validatedInput.canonicalEntryIds,
      run.validatedOutput,
    );
    if (!references.ok) return references;

    try {
      const inserted = await this.executor.query(INSERT_AGENT_SQL, agentParameters(run));
      const identity = parseIdentityRows(
        inserted.rows,
        inserted.rowCount,
        'agent_run',
        run.agentRunId,
      );
      if (!identity.ok) return identity;
      if (inserted.rowCount === 1 && identity.value[0]?.id === run.agentRunId) {
        return success({ outcome: 'inserted', value: normalizeAgentRun(run) });
      }
      if (inserted.rowCount !== 0) {
        return failure(corruptData('agent_run', run.agentRunId, 'Unexpected agent count'));
      }
      const existing = await this.loadAgent(interviewId, run.agentRunId);
      if (!existing.ok) return existing;
      return sameAgentRun(existing.value, run)
        ? success({ outcome: 'existing', value: existing.value })
        : duplicate('agent_run', run.agentRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'agent_run', run.agentRunId);
    }
  }

  public async finishAgent(
    interviewId: string,
    agentRunId: string,
    expectedStatus: 'running',
    next: StoredAgentRun,
  ): Promise<RepositoryResult<StoredAgentRun>> {
    const issue = validateAgent(interviewId, next);
    if (issue !== null) return constraint(issue);
    if (next.agentRunId !== agentRunId || !isTerminal(next.status)) {
      return constraint('agent_finish_shape');
    }
    const references = await validateRunReferences(
      this.executor,
      interviewId,
      next.validatedInput.transcriptTurnIds,
      next.validatedInput.guideQuestionIds,
      next.validatedInput.canonicalEntryIds,
      next.validatedOutput,
    );
    if (!references.ok) return references;

    try {
      const result = await this.executor.query(
        FINISH_AGENT_SQL,
        agentFinishParameters(next, expectedStatus),
      );
      if (result.rowCount === 1) {
        return parseSingleAgent(result.rows, result.rowCount, interviewId, agentRunId);
      }
      if (result.rowCount !== 0) {
        return failure(corruptData('agent_run', agentRunId, 'Unexpected update count'));
      }
      const existing = await this.loadAgent(interviewId, agentRunId);
      if (!existing.ok) return existing;
      return sameAgentRun(existing.value, next) ? existing : duplicate('agent_run', agentRunId);
    } catch (error: unknown) {
      return databaseFailure(error, 'agent_run', agentRunId);
    }
  }
}

function databaseFailure<T>(
  error: unknown,
  resource: 'workflow_run' | 'agent_run',
  identity: string,
): RepositoryResult<T> {
  return failure(mapDatabaseError(error, { resource, identity }));
}
