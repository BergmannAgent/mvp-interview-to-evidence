import { idSchema, timestampSchema } from '@orgscience/contracts';
import { z } from 'zod';

import { failure, success, type Result } from './persistence/index.js';
import type { RuntimeDependencyError } from './errors.js';

export interface Clock {
  now(): string;
}

export interface Sha256 {
  digestUtf8(value: string): string;
}

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export function readClock(clock: Clock): Result<string, RuntimeDependencyError> {
  try {
    const timestamp = timestampSchema.safeParse(clock.now());
    if (timestamp.success) {
      return success(timestamp.data);
    }
  } catch {
    // Runtime adapters are untrusted boundaries and must not escape into use cases.
  }
  return failure({
    code: 'runtime_dependency_invalid',
    dependency: 'clock',
    message: 'Clock must return an ISO 8601 timestamp with millisecond precision',
  });
}

export function sha256(hasher: Sha256, value: string): Result<string, RuntimeDependencyError> {
  try {
    const digest = sha256DigestSchema.safeParse(hasher.digestUtf8(value));
    if (digest.success) {
      return success(digest.data);
    }
  } catch {
    // Runtime adapters are untrusted boundaries and must not escape into use cases.
  }
  return failure({
    code: 'runtime_dependency_invalid',
    dependency: 'sha256',
    message: 'SHA-256 provider must return a lowercase 64-character hexadecimal digest',
  });
}

export function deterministicId(
  prefix: string,
  identity: string,
  hasher: Sha256,
): Result<string, RuntimeDependencyError> {
  const digest = sha256(hasher, `${prefix}\u001f${identity}`);
  if (!digest.ok) {
    return digest;
  }

  const candidate = `${prefix}:${digest.value}`;
  const validated = idSchema.safeParse(candidate);
  return validated.success
    ? success(validated.data)
    : failure({
        code: 'runtime_dependency_invalid',
        dependency: 'sha256',
        message: 'Deterministic application identifier is outside the shared ID contract',
      });
}
