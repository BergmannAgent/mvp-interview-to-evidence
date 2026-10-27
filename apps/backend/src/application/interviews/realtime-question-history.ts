import type { TranscriptAggregate, TranscriptGuideReference } from '@orgscience/domain';

import type { StoredAiDelivery } from '../persistence/index.js';

export const REALTIME_QUESTION_LIMITS = Object.freeze({ clarifications: 3, repetitions: 1 });

export interface RealtimeQuestionHistory {
  readonly priorClarificationTexts: readonly string[];
  readonly priorClarificationAspects: readonly string[];
  readonly repetitionCount: number;
}

export function realtimeQuestionHistory(
  aggregate: TranscriptAggregate,
  questionId: string,
  deliveries: readonly StoredAiDelivery[],
): RealtimeQuestionHistory {
  const byTurnId = new Map(deliveries.map((delivery) => [delivery.turnId, delivery]));
  const texts: string[] = [];
  const aspects: string[] = [];
  const seen = new Set<string>();
  let repetitionCount = 0;
  for (const entry of aggregate.entries) {
    if (
      entry.kind !== 'turn' ||
      entry.speaker !== 'ai_interviewer' ||
      entry.turnType !== 'clarification_question' ||
      referencedQuestionId(entry.guideReference) !== questionId ||
      !entry.text.trim()
    )
      continue;
    const delivery = byTurnId.get(entry.turnId);
    if (
      delivery !== undefined &&
      ((delivery.status !== 'complete' && delivery.status !== 'interrupted') ||
        !delivery.confirmedSpokenText?.trim())
    )
      continue;
    const metadata = delivery?.planningMetadata;
    const identity =
      metadata == null ? entry.turnId : `${metadata.sourceParticipantTurnId}:${metadata.purpose}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (metadata?.purpose === 'repeat') {
      repetitionCount += 1;
    } else {
      texts.push(delivery?.proposedText ?? entry.text);
      if (metadata?.missingAspect != null) aspects.push(metadata.missingAspect);
    }
  }
  return { priorClarificationTexts: texts, priorClarificationAspects: aspects, repetitionCount };
}

function referencedQuestionId(reference: TranscriptGuideReference | null): string | null {
  return reference?.kind === 'follow_up_question'
    ? reference.followUpQuestionId
    : (reference?.mainQuestionId ?? null);
}
