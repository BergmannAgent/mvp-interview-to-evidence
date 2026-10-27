import { describe, expect, it } from 'vitest';

import { mapDatabaseError } from './repository-errors.js';

const context = { resource: 'transcript' as const, identity: 'turn-1' };

describe('mapDatabaseError', () => {
  it('keeps duplicate, constraint, and transaction failures distinct', () => {
    expect(mapDatabaseError({ code: '23505' }, context)).toEqual({
      code: 'duplicate_conflict',
      resource: 'transcript',
      identity: 'turn-1',
    });
    expect(mapDatabaseError({ code: '23502', constraint: 'required_value' }, context)).toEqual({
      code: 'constraint_violation',
      constraint: 'required_value',
    });
    expect(mapDatabaseError({ code: '40001' }, context)).toEqual({
      code: 'serialization_failure',
      retryable: true,
    });
  });

  it('retries only recognized connection and capacity failures', () => {
    expect(mapDatabaseError({ code: '08006' }, context)).toEqual({
      code: 'unavailable',
      retryable: true,
    });
    expect(mapDatabaseError({ code: 'ECONNRESET' }, context)).toEqual({
      code: 'unavailable',
      retryable: true,
    });
    expect(mapDatabaseError({ code: '55P03' }, context)).toEqual({
      code: 'unavailable',
      retryable: true,
    });
    expect(mapDatabaseError({ code: '57014' }, context)).toEqual({
      code: 'unavailable',
      retryable: true,
    });
  });

  it('classifies unknown SQL states and programming errors as non-retryable', () => {
    expect(mapDatabaseError({ code: 'XX000' }, context)).toEqual({
      code: 'internal',
      retryable: false,
    });
    expect(mapDatabaseError(new Error('programming defect'), context)).toEqual({
      code: 'internal',
      retryable: false,
    });
  });
});
