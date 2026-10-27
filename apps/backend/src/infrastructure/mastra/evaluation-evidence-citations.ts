import {
  profileEvaluationProviderCodingOutputSchema,
  type MvpInterviewSession,
  type ProfileEvaluationEvidenceReference,
} from '@orgscience/contracts';

type EvidenceSource = Pick<
  ProfileEvaluationEvidenceReference,
  'turnId' | 'sequenceNumber' | 'verbatimExcerpt'
>;

/** Restore citation formatting from its unique source; strict validation still follows. */
export function restoreEvaluationEvidenceCitations(
  session: MvpInterviewSession,
  candidate: unknown,
): unknown {
  const parsed = profileEvaluationProviderCodingOutputSchema.safeParse(candidate);
  if (!parsed.success) return candidate;
  const turns = new Map(
    session.transcript
      .filter((turn) => turn.speaker === 'participant')
      .map((turn) => [turn.turnId, turn]),
  );
  function restoreSource<T extends EvidenceSource>(source: T): T {
    const turn = turns.get(source.turnId);
    if (
      turn === undefined ||
      turn.sequenceNumber !== source.sequenceNumber ||
      turn.text.includes(source.verbatimExcerpt)
    ) {
      return source;
    }
    const original = uniqueOriginalExcerpt(turn.text, source.verbatimExcerpt);
    return original === undefined ? source : { ...source, verbatimExcerpt: original };
  }

  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => {
      const restoreBucket = (bucket: typeof item.supportingEvidence) =>
        bucket.map((reference) => ({
          ...restoreSource(reference),
          additionalSources: reference.additionalSources.map(restoreSource),
        }));
      return {
        ...item,
        supportingEvidence: restoreBucket(item.supportingEvidence),
        counterEvidence: restoreBucket(item.counterEvidence),
      };
    }),
  };
}

function uniqueOriginalExcerpt(source: string, excerpt: string): string | undefined {
  const first = Array.from(excerpt)[0];
  if (first === undefined) return undefined;
  const lowercase = first.toLowerCase();
  // Only quotation-initial capitalization and whitespace can vary, never other letters.
  const initial =
    /\p{Lu}/u.test(first) && Array.from(lowercase).length === 1 && lowercase !== first
      ? `(?:${escapePattern(first)}|${escapePattern(lowercase)})`
      : escapePattern(first);
  const rest = excerpt
    .slice(first.length)
    .split(/(\s+)/u)
    .map((part) => (/^\s+$/u.test(part) ? '\\s+' : escapePattern(part)))
    .join('');
  // Lookahead includes overlapping positions, so ambiguous matches cannot be guessed.
  const matches = source.matchAll(new RegExp(`(?=(${initial}${rest}))`, 'gu'));
  const match = matches.next();
  if (match.done || !matches.next().done) return undefined;
  return match.value[1];
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
