import type {
  RepositoryError,
  RepositoryResource,
} from '../../../application/persistence/index.js';

interface RepositoryOperationContext {
  readonly resource: RepositoryResource;
  readonly identity: string;
}

export function mapDatabaseError(
  error: unknown,
  context: RepositoryOperationContext,
): RepositoryError {
  const code = readStringProperty(error, 'code');
  const constraint = readStringProperty(error, 'constraint');

  if (code === '23505') {
    return {
      code: 'duplicate_conflict',
      resource: context.resource,
      identity: context.identity,
    };
  }
  if (code?.startsWith('23') === true) {
    return {
      code: 'constraint_violation',
      constraint: constraint ?? 'unknown_database_constraint',
    };
  }
  if (code?.startsWith('40') === true) {
    return { code: 'serialization_failure', retryable: true };
  }
  if (isUnavailableCode(code)) {
    return { code: 'unavailable', retryable: true };
  }
  return { code: 'internal', retryable: false };
}

function isUnavailableCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  return (
    code.startsWith('08') ||
    code === '53300' ||
    code === '53400' ||
    code === '55P03' ||
    code === '57014' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND'
  );
}

export function corruptData(
  resource: RepositoryResource,
  id: string,
  reason: string,
): RepositoryError {
  return { code: 'corrupt_data', resource, id, reason };
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}
