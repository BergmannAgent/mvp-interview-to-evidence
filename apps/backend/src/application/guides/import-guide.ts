import { interviewGuideSchema, type SupportedLocale } from '@orgscience/contracts';
import {
  parseInterviewGuideMarkdown,
  toInterviewGuideSnapshot,
  type InterviewGuideSnapshot,
} from '@orgscience/domain';

import { failure, success, type AppUnitOfWork } from '../persistence/index.js';
import { readClock, sha256, type Clock, type Sha256 } from '../runtime.js';
import type { ApplicationResult } from '../errors.js';

export interface ImportGuideInput {
  readonly markdown: string;
  readonly sourceLanguage?: SupportedLocale;
}

export interface ImportGuideOutput {
  readonly outcome: 'inserted' | 'existing';
  readonly guide: InterviewGuideSnapshot;
}

export class ImportGuideService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly hasher: Sha256,
  ) {}

  public async execute(input: ImportGuideInput): Promise<ApplicationResult<ImportGuideOutput>> {
    const parsed = parseInterviewGuideMarkdown(input.markdown, input.sourceLanguage ?? 'de');
    if (!parsed.success) {
      return failure({ code: 'guide_invalid', issues: parsed.issues });
    }

    const importedAt = readClock(this.clock);
    if (!importedAt.ok) {
      return importedAt;
    }
    const sourceHash = sha256(this.hasher, input.markdown);
    if (!sourceHash.ok) {
      return sourceHash;
    }

    const snapshot = toInterviewGuideSnapshot(parsed.guide, input.markdown, importedAt.value);
    const validated = interviewGuideSchema.safeParse(snapshot);
    if (!validated.success) {
      return failure({
        code: 'application_invariant',
        resource: 'guide',
        id: snapshot.id,
        message: 'Parsed guide does not satisfy the shared guide contract',
      });
    }

    return this.unitOfWork.transaction(async ({ guides }) => {
      const imported = await guides.import(snapshot.id, {
        guideId: snapshot.id,
        guide: snapshot,
        sourceHash: sourceHash.value,
        importedAt: importedAt.value,
      });
      if (!imported.ok) {
        return imported;
      }

      return success({
        outcome: imported.value.outcome,
        guide: imported.value.value.guide,
      });
    });
  }
}
