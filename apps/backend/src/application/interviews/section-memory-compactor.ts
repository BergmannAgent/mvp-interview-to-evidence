import type { SectionMemory } from '@orgscience/contracts';
import {
  createDeterministicSectionMemory,
  validateSectionMemoryAgainstSource,
  type SectionMemorySource,
} from '@orgscience/domain';

export interface SectionMemoryCompactor {
  compact(source: SectionMemorySource): Promise<unknown>;
}

export const deterministicSectionMemoryCompactor: SectionMemoryCompactor = {
  compact(source): Promise<SectionMemory> {
    return Promise.resolve(createDeterministicSectionMemory(source));
  },
};

export async function compactSectionWithTimeout(
  compactor: SectionMemoryCompactor,
  source: SectionMemorySource,
  timeoutMs: number,
): Promise<SectionMemory> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const candidate = await Promise.race([
      compactor.compact(source),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Section-memory compaction timed out')),
          timeoutMs,
        );
      }),
    ]);
    return validateSectionMemoryAgainstSource(candidate, source);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
