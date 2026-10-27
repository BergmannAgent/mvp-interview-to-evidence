import {
  canonicalTranscriptTurnSchema,
  idSchema,
  providerEventIdSchema,
  transcriptProviderSchema,
  transcriptTechnicalGapSchema,
} from '@orgscience/contracts';
import {
  ingestFinalParticipantSegment,
  TranscriptDomainError,
  type AiTranscriptTurn,
  type CanonicalTranscriptEntry,
  type FinalizedParticipantSegment,
  type ParticipantTranscriptTurn,
  type PartialTranscriptSegment,
  type TranscriptAggregate,
  type TranscriptTechnicalGap,
} from '@orgscience/domain';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';

import {
  failure,
  success,
  type AiDeliveryReservation,
  type GappedAiDeliveryWrite,
  type IdempotentWrite,
  type PartialWrite,
  type RepositoryResult,
  type ResolvedAiTurnWrite,
  type SpeechRecognitionSource,
  type StoredAiDelivery,
} from '../../../application/persistence/index.js';
import type { TranscriptRepository } from '../../../application/persistence/ports.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';
import {
  entryId,
  parseEntries,
  parseFinals,
  parseGuideIndex,
  parseRows,
  parseSingleRow,
  questionId,
  referenceMatchesTurnType,
  toPartial,
  toStoredAiDelivery,
} from './transcript-repository-mappers.js';
import {
  aggregateHeaderRowSchema,
  aiDeliveryReservationInputSchema,
  currentSequenceRowSchema,
  finalIdentityRowSchema,
  finalizedSourceIdentityRowSchema,
  finalInputSchema,
  gappedSourceIdentityRowSchema,
  gapIdentityRowSchema,
  partialInputSchema,
  partialRowSchema,
  segmentResolutionRowSchema,
  sequenceRowSchema,
  speechRecognitionSourceSchema,
  storedAiDeliveryRowSchema,
  storedPartialRowSchema,
  timestampInputSchema,
  transcriptMutationVersionRowSchema,
  transcriptWriteGuardRowSchema,
} from './transcript-repository-schemas.js';
import {
  ALLOCATE_TRANSCRIPT_SEQUENCE_SQL,
  BUMP_TRANSCRIPT_MUTATION_VERSION_SQL,
  GAP_AI_DELIVERY_SQL,
  INITIALIZE_COUNTER_SQL,
  INSERT_AI_TURN_SQL,
  INSERT_FINAL_SEGMENT_SQL,
  INSERT_PENDING_AI_DELIVERY_SQL,
  INSERT_PARTIAL_SQL,
  INSERT_PARTICIPANT_TURN_SQL,
  INSERT_TECHNICAL_GAP_SQL,
  INSERT_TRANSCRIPT_ENTRY_SQL,
  LOAD_AGGREGATE_HEADER_SQL,
  LOAD_AI_DELIVERY_SQL,
  LOAD_AI_DELIVERY_IDENTITIES_SQL,
  LOAD_CURRENT_SEQUENCE_SQL,
  LOAD_ENTRIES_SQL,
  LOAD_FINAL_IDENTITIES_SQL,
  LOAD_FINAL_BY_SOURCE_IDENTITY_SQL,
  LOAD_FINALS_SQL,
  LOAD_GAP_IDENTITIES_SQL,
  LOAD_GUIDE_QUESTIONS_SQL,
  LOAD_LATEST_PARTIAL_SQL,
  LOAD_PARTIAL_BY_EVENT_SQL,
  LOAD_PENDING_AI_DELIVERIES_SQL,
  LOAD_QUESTION_AI_DELIVERIES_SQL,
  LOAD_SEGMENT_RESOLUTION_SQL,
  LOAD_STT_GAP_BY_SOURCE_IDENTITY_SQL,
  LOAD_UNRESOLVED_PARTIALS_SQL,
  LOCK_AGGREGATE_SQL,
  LOCK_TRANSCRIPT_WRITE_SQL,
  MARK_PROVIDER_PARTIALS_STALE_SQL,
  RESOLVE_AI_DELIVERY_SQL,
  RESOLVE_PARTIALS_SQL,
  RESOLVE_UTTERANCE_PARTIALS_SQL,
} from './transcript-repository-sql.js';

export class PostgresTranscriptRepository implements TranscriptRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async initialize(
    interviewId: string,
    aggregate: TranscriptAggregate,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptAggregate>>> {
    if (interviewId !== aggregate.interviewId) {
      return duplicateConflict('transcript', interviewId);
    }
    try {
      const inserted = await this.executor.query(INITIALIZE_COUNTER_SQL, [interviewId]);
      const loaded = await this.loadAggregate(interviewId);
      if (!loaded.ok) {
        return loaded;
      }
      if (!isDeepStrictEqual(loaded.value, aggregate)) {
        return duplicateConflict('transcript', interviewId);
      }
      return success({
        outcome: inserted.rowCount === 1 ? 'inserted' : 'existing',
        value: loaded.value,
      });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  public async loadAggregate(interviewId: string): Promise<RepositoryResult<TranscriptAggregate>> {
    try {
      const headerResult = await this.executor.query(LOAD_AGGREGATE_HEADER_SQL, [interviewId]);
      const header = parseSingleRow(
        headerResult.rows,
        aggregateHeaderRowSchema,
        'transcript',
        interviewId,
      );
      if (!header.ok) {
        return header;
      }
      if (header.value.interviewId !== interviewId) {
        return failure(corruptData('transcript', interviewId, 'Cross-interview aggregate header'));
      }

      const questionsResult = await this.executor.query(LOAD_GUIDE_QUESTIONS_SQL, [
        header.value.guideId,
      ]);
      const guideIndex = parseGuideIndex(questionsResult.rows, header.value.guideId, interviewId);
      if (!guideIndex.ok) {
        return guideIndex;
      }

      const entriesResult = await this.executor.query(LOAD_ENTRIES_SQL, [interviewId]);
      const entries = parseEntries(entriesResult.rows, interviewId, header.value.guideId);
      if (!entries.ok) {
        return entries;
      }
      const lastEntry = entries.value.at(-1);
      const canonicalNextSequence = (lastEntry?.sequenceNumber ?? 0) + 1;
      const pendingDeliveries = await this.listPendingAiDeliveries(interviewId);
      if (!pendingDeliveries.ok) {
        return pendingDeliveries;
      }
      const pendingDelivery = pendingDeliveries.value[0];
      const counterIsConsistent =
        pendingDelivery === undefined
          ? header.value.nextSequenceNumber === canonicalNextSequence
          : pendingDeliveries.value.length === 1 &&
            pendingDelivery.reservedSequenceNumber === canonicalNextSequence &&
            header.value.nextSequenceNumber === canonicalNextSequence + 1;
      if (!counterIsConsistent) {
        return failure(
          corruptData(
            'transcript',
            interviewId,
            `Counter ${header.value.nextSequenceNumber} is inconsistent with canonical sequence ${canonicalNextSequence}`,
          ),
        );
      }

      const finalsResult = await this.executor.query(LOAD_FINALS_SQL, [interviewId]);
      const finals = parseFinals(finalsResult.rows, entries.value, interviewId);
      if (!finals.ok) {
        return finals;
      }

      const partialsResult = await this.executor.query(LOAD_UNRESOLVED_PARTIALS_SQL, [interviewId]);
      const partials = parseRows(partialsResult.rows, partialRowSchema, 'transcript', interviewId);
      if (!partials.ok) {
        return partials;
      }
      if (partials.value.some((partial) => partial.interviewId !== interviewId)) {
        return failure(corruptData('transcript', interviewId, 'Cross-interview partial row'));
      }

      return success({
        interviewId: header.value.interviewId,
        guideId: header.value.guideId,
        guideQuestionIndex: guideIndex.value,
        nextSequenceNumber: canonicalNextSequence,
        entries: entries.value,
        partials: partials.value,
        finals: finals.value,
      });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  public async lockAggregate(interviewId: string): Promise<RepositoryResult<TranscriptAggregate>> {
    try {
      const locked = await this.executor.query(LOCK_AGGREGATE_SQL, [interviewId]);
      if (locked.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'transcript', id: interviewId });
      }
      return this.loadAggregate(interviewId);
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  public async loadAiDelivery(
    interviewId: string,
    deliveryId: string,
  ): Promise<RepositoryResult<StoredAiDelivery>> {
    try {
      const result = await this.executor.query(LOAD_AI_DELIVERY_SQL, [interviewId, deliveryId]);
      const rows = this.parseAiDeliveries(result.rows, interviewId, deliveryId);
      if (!rows.ok) return rows;
      if (rows.value.length === 0) {
        return failure({ code: 'not_found', resource: 'transcript', id: deliveryId });
      }
      if (rows.value.length !== 1) {
        return failure(corruptData('transcript', deliveryId, 'Duplicate AI delivery rows'));
      }
      return success(rows.value[0]!);
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', deliveryId);
    }
  }

  public async listPendingAiDeliveries(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredAiDelivery[]>> {
    try {
      const result = await this.executor.query(LOAD_PENDING_AI_DELIVERIES_SQL, [interviewId]);
      const deliveries = this.parseAiDeliveries(result.rows, interviewId, interviewId);
      if (!deliveries.ok) return deliveries;
      return deliveries.value.length <= 1
        ? deliveries
        : failure(corruptData('transcript', interviewId, 'Multiple pending AI deliveries'));
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  public async listQuestionAiDeliveries(
    interviewId: string,
    questionId: string,
  ): Promise<RepositoryResult<readonly StoredAiDelivery[]>> {
    try {
      const result = await this.executor.query(LOAD_QUESTION_AI_DELIVERIES_SQL, [
        interviewId,
        questionId,
      ]);
      const deliveries = this.parseAiDeliveries(result.rows, interviewId, questionId);
      if (!deliveries.ok) return deliveries;
      return deliveries.value.every(
        (delivery) =>
          questionId ===
          (delivery.guideReference?.kind === 'follow_up_question'
            ? delivery.guideReference.followUpQuestionId
            : delivery.guideReference?.mainQuestionId),
      )
        ? deliveries
        : failure(corruptData('transcript', interviewId, 'Cross-question AI delivery history'));
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  public async upsertPartial(
    interviewId: string,
    source: SpeechRecognitionSource,
    partial: PartialTranscriptSegment,
  ): Promise<RepositoryResult<PartialWrite<PartialTranscriptSegment>>> {
    const parsedInput = partialInputSchema.safeParse(partial);
    const parsedSource = speechRecognitionSourceSchema.safeParse(source);
    if (
      !parsedInput.success ||
      !parsedSource.success ||
      parsedInput.data.interviewId !== interviewId ||
      parsedInput.data.sourceProvider !== parsedSource.data.provider ||
      parsedInput.data.utteranceId !== parsedSource.data.utteranceId
    ) {
      return duplicateConflict('transcript', partial.providerEventId);
    }
    try {
      const existing = await this.findExistingPartial(source, partial);
      if (!existing.ok) return existing;
      if (existing.value !== null) return success(existing.value);

      const guard = await this.lockTranscriptWrite(interviewId);
      if (!guard.ok) return guard;
      const raced = await this.findExistingPartial(source, partial);
      if (!raced.ok) return raced;
      if (raced.value !== null) return success(raced.value);
      if (this.transcriptIsClosed(guard.value)) {
        await this.insertPartial(source, partial, 'ignored_finalized');
        return success({ outcome: 'ignored_finalized', value: partial });
      }

      const resolutionResult = await this.executor.query(LOAD_SEGMENT_RESOLUTION_SQL, [
        interviewId,
        source.provider,
        partial.segmentId,
        partial.providerEventId,
        source.utteranceId,
      ]);
      const resolution = parseSingleRow(
        resolutionResult.rows,
        segmentResolutionRowSchema,
        'transcript',
        partial.segmentId,
      );
      if (!resolution.ok) {
        return resolution;
      }
      if (
        resolution.value.providerEventFinalSegmentId !== null &&
        resolution.value.providerEventFinalSegmentId !== partial.segmentId
      ) {
        return duplicateConflict('transcript', partial.providerEventId);
      }
      if (resolution.value.isFinalized || resolution.value.hasGap) {
        await this.insertPartial(source, partial, 'ignored_finalized');
        return success({
          outcome: 'ignored_finalized',
          value: partial,
        });
      }

      const latestResult = await this.executor.query(LOAD_LATEST_PARTIAL_SQL, [
        interviewId,
        source.provider,
        partial.segmentId,
      ]);
      if (latestResult.rowCount > 0) {
        const latest = parseSingleRow(
          latestResult.rows,
          storedPartialRowSchema,
          'transcript',
          partial.segmentId,
        );
        if (!latest.ok) {
          return latest;
        }
        if (latest.value.utteranceId !== source.utteranceId) {
          return duplicateConflict('transcript', partial.segmentId);
        }
        if (latest.value.revision >= partial.revision) {
          return success({ outcome: 'ignored_stale', value: toPartial(latest.value) });
        }
        await this.executor.query(MARK_PROVIDER_PARTIALS_STALE_SQL, [
          interviewId,
          source.provider,
          partial.segmentId,
        ]);
      }

      const disposition = latestResult.rowCount === 0 ? 'accepted' : 'updated';
      await this.insertPartial(source, partial, disposition);
      const fence = await this.bumpTranscriptMutationVersion(interviewId);
      if (!fence.ok) return fence;
      return success({
        outcome: disposition === 'accepted' ? 'inserted' : 'updated',
        value: partial,
      });
    } catch (error: unknown) {
      const mapped = mapDatabaseError(error, {
        resource: 'transcript',
        identity: partial.providerEventId,
      });
      return mapped.code === 'duplicate_conflict'
        ? failure({ code: 'serialization_failure', retryable: true })
        : failure(mapped);
    }
  }

  public async appendParticipantFinal(
    interviewId: string,
    expectedSequenceNumber: number,
    source: SpeechRecognitionSource,
    final: FinalizedParticipantSegment,
    turn: ParticipantTranscriptTurn,
  ): Promise<RepositoryResult<IdempotentWrite<ParticipantTranscriptTurn>>> {
    const validFinal = finalInputSchema.safeParse(final).success;
    const validTurn = canonicalTranscriptTurnSchema.safeParse(turn).success;
    const validSource = speechRecognitionSourceSchema.safeParse(source).success;
    if (
      !validFinal ||
      !validTurn ||
      !validSource ||
      final.sourceProvider !== source.provider ||
      final.utteranceId !== source.utteranceId ||
      turn.sourceProvider !== source.provider ||
      final.interviewId !== interviewId ||
      turn.interviewId !== interviewId ||
      turn.sequenceNumber !== expectedSequenceNumber ||
      turn.turnId !== final.turnId ||
      turn.providerEventId !== final.providerEventId ||
      turn.sourceSegmentId !== final.segmentId ||
      turn.text !== final.text ||
      !sameTimestamp(turn.occurredAt, final.occurredAt) ||
      Date.parse(final.observedAt) < Date.parse(final.occurredAt) ||
      Date.parse(final.finalizedAt) < Date.parse(final.observedAt) ||
      !isDeepStrictEqual(turn.guideReference, final.guideReference)
    ) {
      return duplicateConflict('transcript', turn.turnId);
    }

    const existing = await this.findExistingParticipant(interviewId, source, final, turn);
    if (!existing.ok || existing.value !== null) {
      return existing.ok ? success({ outcome: 'existing', value: existing.value! }) : existing;
    }

    const guard = await this.lockTranscriptWrite(interviewId);
    if (!guard.ok) return guard;
    const raced = await this.findExistingParticipant(interviewId, source, final, turn);
    if (!raced.ok || raced.value !== null) {
      return raced.ok ? success({ outcome: 'existing', value: raced.value! }) : raced;
    }
    const guarded = this.validateNewCanonicalWrite(
      guard.value,
      expectedSequenceNumber,
      turn.occurredAt,
    );
    if (!guarded.ok) return guarded;
    const participantInvariant = await this.validateParticipantInvariant(interviewId, final);
    if (!participantInvariant.ok) return participantInvariant;

    const allocated = await this.allocateTranscriptSequence(interviewId, expectedSequenceNumber);
    if (!allocated.ok) {
      const retried = await this.findExistingParticipant(interviewId, source, final, turn);
      return retried.ok && retried.value !== null
        ? success({ outcome: 'existing', value: retried.value })
        : allocated;
    }

    try {
      await this.insertEntry(turn);
      await this.executor.query(INSERT_PARTICIPANT_TURN_SQL, [
        interviewId,
        turn.turnId,
        turn.text,
        turn.guideReference?.guideId ?? null,
        questionId(turn.guideReference),
        source.provider,
        turn.providerEventId,
        turn.sourceSegmentId,
      ]);
      await this.executor.query(INSERT_FINAL_SEGMENT_SQL, [
        interviewId,
        source.provider,
        final.providerEventId,
        final.segmentId,
        source.utteranceId,
        final.turnId,
        final.text,
        final.observedAt,
        final.finalizedAt,
      ]);
      await this.resolvePartials(
        interviewId,
        final.segmentId,
        'ignored_finalized',
        source.provider,
        source.utteranceId,
      );
      return success({ outcome: 'inserted', value: turn });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', turn.turnId);
    }
  }

  public async reserveAiDelivery(
    interviewId: string,
    expectedSequenceNumber: number,
    reservation: AiDeliveryReservation,
  ): Promise<RepositoryResult<IdempotentWrite<StoredAiDelivery>>> {
    if (!this.validReservation(interviewId, reservation)) {
      return duplicateConflict('transcript', reservation.deliveryId);
    }
    const existing = await this.findDeliveryIdentity(interviewId, reservation);
    if (!existing.ok || existing.value !== null) {
      return existing.ok ? success({ outcome: 'existing', value: existing.value! }) : existing;
    }

    const guard = await this.lockTranscriptWrite(interviewId);
    if (!guard.ok) return guard;
    const raced = await this.findDeliveryIdentity(interviewId, reservation);
    if (!raced.ok || raced.value !== null) {
      return raced.ok ? success({ outcome: 'existing', value: raced.value! }) : raced;
    }
    const guarded = this.validateNewCanonicalWrite(
      guard.value,
      expectedSequenceNumber,
      reservation.createdAt,
    );
    if (!guarded.ok) return guarded;
    const allocated = await this.allocateTranscriptSequence(interviewId, expectedSequenceNumber);
    if (!allocated.ok) return allocated;

    try {
      await this.executor.query(INSERT_PENDING_AI_DELIVERY_SQL, [
        reservation.deliveryId,
        interviewId,
        reservation.jobId,
        reservation.workflowRunId,
        reservation.turnId,
        reservation.utteranceId,
        expectedSequenceNumber,
        reservation.turnType,
        reservation.guideReference?.guideId ?? null,
        questionId(reservation.guideReference),
        reservation.proposedText,
        reservation.createdAt,
        reservation.planningMetadata == null ? null : JSON.stringify(reservation.planningMetadata),
      ]);
      return success({
        outcome: 'inserted',
        value: this.pendingDelivery(interviewId, expectedSequenceNumber, reservation),
      });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', reservation.deliveryId);
    }
  }

  public async resolveAiDelivery(
    interviewId: string,
    write: ResolvedAiTurnWrite,
  ): Promise<RepositoryResult<IdempotentWrite<AiTranscriptTurn>>> {
    const delivery = await this.loadAiDelivery(interviewId, write.deliveryId);
    if (!delivery.ok) return delivery;
    const existing = await this.existingResolvedTurn(interviewId, delivery.value, write);
    if (!existing.ok || existing.value !== null) {
      return existing.ok ? success({ outcome: 'existing', value: existing.value! }) : existing;
    }
    if (!this.validResolution(delivery.value, write)) {
      return duplicateConflict('transcript', write.deliveryId);
    }

    const guard = await this.lockTranscriptWrite(interviewId);
    if (!guard.ok) return guard;
    const current = await this.loadAiDelivery(interviewId, write.deliveryId);
    if (!current.ok) return current;
    const raced = await this.existingResolvedTurn(interviewId, current.value, write);
    if (!raced.ok || raced.value !== null) {
      return raced.ok ? success({ outcome: 'existing', value: raced.value! }) : raced;
    }
    if (!this.validResolution(current.value, write)) {
      return duplicateConflict('transcript', write.deliveryId);
    }
    const guarded = this.validateReservedCanonicalWrite(
      guard.value,
      current.value,
      write.turn.occurredAt,
    );
    if (!guarded.ok) return guarded;

    try {
      const updated = await this.executor.query(RESOLVE_AI_DELIVERY_SQL, [
        interviewId,
        write.deliveryId,
        write.turn.delivery.status,
        write.provider,
        write.providerDeliveryEventId,
        write.turn.text,
        write.resolvedAt,
        write.turn.delivery.status === 'interrupted' ? write.turn.delivery.interruptedAt : null,
      ]);
      if (updated.rowCount !== 1) {
        return duplicateConflict('transcript', write.deliveryId);
      }
      await this.insertEntry(write.turn);
      await this.executor.query(INSERT_AI_TURN_SQL, [
        interviewId,
        write.turn.turnId,
        write.turn.turnType,
        write.turn.text,
        write.turn.guideReference?.guideId ?? null,
        questionId(write.turn.guideReference),
        write.deliveryId,
        write.providerDeliveryEventId,
        write.turn.delivery.status,
        write.turn.delivery.status === 'interrupted' ? write.turn.delivery.interruptedAt : null,
      ]);
      return success({ outcome: 'inserted', value: write.turn });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', write.deliveryId);
    }
  }

  public async gapAiDelivery(
    interviewId: string,
    write: GappedAiDeliveryWrite,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptTechnicalGap>>> {
    if (
      !timestampInputSchema.safeParse(write.resolvedAt).success ||
      !transcriptTechnicalGapSchema.safeParse(write.gap).success ||
      write.gap.interviewId !== interviewId ||
      write.gap.source === 'speech_to_text'
    ) {
      return duplicateConflict('transcript', write.deliveryId);
    }
    const delivery = await this.loadAiDelivery(interviewId, write.deliveryId);
    if (!delivery.ok) return delivery;
    const existing = await this.existingGappedDelivery(interviewId, delivery.value, write);
    if (!existing.ok || existing.value !== null) {
      return existing.ok ? success({ outcome: 'existing', value: existing.value! }) : existing;
    }
    if (!this.validGap(delivery.value, write)) {
      return duplicateConflict('transcript', write.deliveryId);
    }

    const guard = await this.lockTranscriptWrite(interviewId);
    if (!guard.ok) return guard;
    const current = await this.loadAiDelivery(interviewId, write.deliveryId);
    if (!current.ok) return current;
    const raced = await this.existingGappedDelivery(interviewId, current.value, write);
    if (!raced.ok || raced.value !== null) {
      return raced.ok ? success({ outcome: 'existing', value: raced.value! }) : raced;
    }
    if (!this.validGap(current.value, write)) {
      return duplicateConflict('transcript', write.deliveryId);
    }
    const guarded = this.validateReservedCanonicalWrite(
      guard.value,
      current.value,
      write.gap.occurredAt,
    );
    if (!guarded.ok) return guarded;

    try {
      const updated = await this.executor.query(GAP_AI_DELIVERY_SQL, [
        interviewId,
        write.deliveryId,
        write.status,
        write.resolvedAt,
      ]);
      if (updated.rowCount !== 1) {
        return duplicateConflict('transcript', write.deliveryId);
      }
      await this.insertEntry(write.gap);
      await this.executor.query(INSERT_TECHNICAL_GAP_SQL, [
        interviewId,
        write.gap.gapId,
        write.gap.source,
        write.gap.sourceProvider,
        write.gap.description,
        write.gap.relatedSegmentId,
        write.gap.relatedUtteranceId,
        write.gap.sourceEventId,
      ]);
      return success({ outcome: 'inserted', value: write.gap });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', write.deliveryId);
    }
  }

  public async appendTechnicalGap(
    interviewId: string,
    expectedSequenceNumber: number,
    gap: TranscriptTechnicalGap,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptTechnicalGap>>> {
    if (
      !transcriptTechnicalGapSchema.safeParse(gap).success ||
      gap.interviewId !== interviewId ||
      gap.sequenceNumber !== expectedSequenceNumber
    ) {
      return duplicateConflict('transcript', gap.gapId);
    }
    const existing = await this.findExistingGap(interviewId, gap);
    if (!existing.ok || existing.value !== null) {
      return existing.ok ? success({ outcome: 'existing', value: existing.value! }) : existing;
    }
    const guard = await this.lockTranscriptWrite(interviewId);
    if (!guard.ok) return guard;
    const raced = await this.findExistingGap(interviewId, gap);
    if (!raced.ok || raced.value !== null) {
      return raced.ok ? success({ outcome: 'existing', value: raced.value! }) : raced;
    }
    const guarded = this.validateNewCanonicalWrite(
      guard.value,
      expectedSequenceNumber,
      gap.occurredAt,
    );
    if (!guarded.ok) return guarded;
    if (gap.source === 'speech_to_text') {
      const finalized = await this.hasFinalizedSourceIdentity(
        interviewId,
        gap.sourceProvider,
        gap.relatedUtteranceId,
        gap.relatedSegmentId,
      );
      if (!finalized.ok) return finalized;
      if (finalized.value) {
        return duplicateConflict('transcript', `${gap.sourceProvider}:${gap.relatedUtteranceId}`);
      }
    }
    const allocated = await this.allocateTranscriptSequence(interviewId, expectedSequenceNumber);
    if (!allocated.ok) {
      const retried = await this.findExistingGap(interviewId, gap);
      return retried.ok && retried.value !== null
        ? success({ outcome: 'existing', value: retried.value })
        : allocated;
    }
    try {
      await this.insertEntry(gap);
      await this.executor.query(INSERT_TECHNICAL_GAP_SQL, [
        interviewId,
        gap.gapId,
        gap.source,
        gap.sourceProvider,
        gap.description,
        gap.relatedSegmentId,
        gap.relatedUtteranceId,
        gap.sourceEventId,
      ]);
      if (gap.source === 'speech_to_text' && gap.sourceProvider !== null) {
        await this.resolvePartials(
          interviewId,
          gap.relatedSegmentId,
          'ignored_finalized',
          gap.sourceProvider,
          gap.relatedUtteranceId,
        );
      }
      return success({ outcome: 'inserted', value: gap });
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', gap.gapId);
    }
  }

  private async allocateTranscriptSequence(
    interviewId: string,
    expectedSequenceNumber: number,
  ): Promise<RepositoryResult<number>> {
    try {
      const allocatedResult = await this.executor.query(ALLOCATE_TRANSCRIPT_SEQUENCE_SQL, [
        interviewId,
        expectedSequenceNumber,
      ]);
      if (allocatedResult.rowCount === 1) {
        const allocated = parseSingleRow(
          allocatedResult.rows,
          sequenceRowSchema,
          'transcript',
          interviewId,
        );
        return allocated.ok ? success(allocated.value.allocatedSequence) : allocated;
      }
      const currentResult = await this.executor.query(LOAD_CURRENT_SEQUENCE_SQL, [interviewId]);
      if (currentResult.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'transcript', id: interviewId });
      }
      const current = parseSingleRow(
        currentResult.rows,
        currentSequenceRowSchema,
        'transcript',
        interviewId,
      );
      return current.ok
        ? failure({
            code: 'sequence_conflict',
            interviewId,
            expected: expectedSequenceNumber,
            actual: current.value.nextSequenceNumber,
          })
        : current;
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  private async insertEntry(entry: CanonicalTranscriptEntry): Promise<void> {
    await this.executor.query(INSERT_TRANSCRIPT_ENTRY_SQL, [
      entry.interviewId,
      entry.sequenceNumber,
      entryId(entry),
      entry.kind,
      entry.occurredAt,
    ]);
  }

  private async insertPartial(
    source: SpeechRecognitionSource,
    partial: PartialTranscriptSegment,
    disposition: 'accepted' | 'updated' | 'ignored_stale' | 'ignored_finalized',
  ): Promise<void> {
    await this.executor.query(INSERT_PARTIAL_SQL, [
      partial.interviewId,
      source.provider,
      partial.providerEventId,
      partial.segmentId,
      source.utteranceId,
      partial.revision,
      partial.text,
      disposition,
      partial.observedAt,
    ]);
  }

  private async bumpTranscriptMutationVersion(
    interviewId: string,
  ): Promise<RepositoryResult<void>> {
    const result = await this.executor.query(BUMP_TRANSCRIPT_MUTATION_VERSION_SQL, [interviewId]);
    const version = parseSingleRow(
      result.rows,
      transcriptMutationVersionRowSchema,
      'transcript',
      interviewId,
    );
    return version.ok ? success(undefined) : version;
  }

  private async findExistingPartial(
    source: SpeechRecognitionSource,
    partial: PartialTranscriptSegment,
  ): Promise<RepositoryResult<PartialWrite<PartialTranscriptSegment> | null>> {
    const eventResult = await this.executor.query(LOAD_PARTIAL_BY_EVENT_SQL, [
      partial.interviewId,
      source.provider,
      partial.providerEventId,
    ]);
    if (eventResult.rowCount === 0) return success(null);
    const existing = parseSingleRow(
      eventResult.rows,
      storedPartialRowSchema,
      'transcript',
      partial.providerEventId,
    );
    if (!existing.ok) return existing;
    if (
      existing.value.provider !== source.provider ||
      existing.value.utteranceId !== source.utteranceId ||
      !samePartial(toPartial(existing.value), partial)
    ) {
      return duplicateConflict('transcript', partial.providerEventId);
    }
    const outcome =
      existing.value.disposition === 'ignored_finalized'
        ? 'ignored_finalized'
        : existing.value.disposition === 'ignored_stale'
          ? 'ignored_stale'
          : 'existing';
    return success({ outcome, value: partial });
  }

  private async findExistingParticipant(
    interviewId: string,
    source: SpeechRecognitionSource,
    final: FinalizedParticipantSegment,
    turn: ParticipantTranscriptTurn,
  ): Promise<RepositoryResult<ParticipantTranscriptTurn | null>> {
    try {
      const identityResult = await this.executor.query(LOAD_FINAL_IDENTITIES_SQL, [
        interviewId,
        source.provider,
        source.utteranceId,
        final.providerEventId,
        final.segmentId,
        final.turnId,
      ]);
      const identities = parseRows(
        identityResult.rows,
        finalIdentityRowSchema,
        'transcript',
        turn.turnId,
      );
      if (!identities.ok) return identities;
      if (identities.value.length === 0) {
        const gapped = await this.hasGappedSourceIdentity(interviewId, source, final.segmentId);
        if (!gapped.ok) return gapped;
        return gapped.value
          ? duplicateConflict('transcript', `${source.provider}:${source.utteranceId}`)
          : success(null);
      }
      if (identities.value.length !== 1) {
        return duplicateConflict('transcript', `${source.provider}:${source.utteranceId}`);
      }
      const identity = identities.value[0]!;
      if (identity.provider !== source.provider || identity.utteranceId !== source.utteranceId) {
        return duplicateConflict('transcript', turn.turnId);
      }

      const aggregate = await this.loadAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const existingFinal = aggregate.value.finals.find(
        (candidate) => candidate.turnId === identity.turnId,
      );
      const existingTurn = aggregate.value.entries.find(
        (entry): entry is ParticipantTranscriptTurn =>
          entry.kind === 'turn' &&
          entry.speaker === 'participant' &&
          entry.turnId === identity.turnId,
      );
      if (existingFinal === undefined || existingTurn === undefined) {
        return failure(
          corruptData('transcript', identity.turnId, 'Final source has no canonical turn'),
        );
      }
      const sameSemanticTurn =
        existingFinal.text === final.text &&
        sameTimestamp(existingFinal.occurredAt, final.occurredAt) &&
        sameTimestamp(existingFinal.observedAt, final.observedAt) &&
        sameTimestamp(existingFinal.finalizedAt, final.finalizedAt) &&
        isDeepStrictEqual(existingFinal.guideReference, final.guideReference) &&
        existingTurn.text === turn.text &&
        sameTimestamp(existingTurn.occurredAt, turn.occurredAt) &&
        isDeepStrictEqual(existingTurn.guideReference, turn.guideReference);
      return sameSemanticTurn
        ? success(existingTurn)
        : duplicateConflict('transcript', `${source.provider}:${source.utteranceId}`);
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', turn.turnId);
    }
  }

  private async findDeliveryIdentity(
    interviewId: string,
    reservation: AiDeliveryReservation,
  ): Promise<RepositoryResult<StoredAiDelivery | null>> {
    try {
      const result = await this.executor.query(LOAD_AI_DELIVERY_IDENTITIES_SQL, [
        interviewId,
        reservation.deliveryId,
        reservation.turnId,
        reservation.utteranceId,
      ]);
      const deliveries = this.parseAiDeliveries(result.rows, interviewId, reservation.deliveryId);
      if (!deliveries.ok) return deliveries;
      if (deliveries.value.length === 0) return success(null);
      if (deliveries.value.length !== 1) {
        return duplicateConflict('transcript', reservation.deliveryId);
      }
      const existing = deliveries.value[0]!;
      return this.sameReservation(existing, reservation)
        ? success(existing)
        : duplicateConflict('transcript', reservation.deliveryId);
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', reservation.deliveryId);
    }
  }

  private async hasGappedSourceIdentity(
    interviewId: string,
    source: SpeechRecognitionSource,
    segmentId: string,
  ): Promise<RepositoryResult<boolean>> {
    const result = await this.executor.query(LOAD_STT_GAP_BY_SOURCE_IDENTITY_SQL, [
      interviewId,
      source.provider,
      source.utteranceId,
      segmentId,
    ]);
    const parsed = parseRows(
      result.rows,
      gappedSourceIdentityRowSchema,
      'transcript',
      `${source.provider}:${source.utteranceId}`,
    );
    if (!parsed.ok) return parsed;
    return parsed.value.length <= 1
      ? success(parsed.value.length === 1)
      : failure(
          corruptData(
            'transcript',
            `${source.provider}:${source.utteranceId}`,
            'Duplicate STT gaps for provider source identity',
          ),
        );
  }

  private async hasFinalizedSourceIdentity(
    interviewId: string,
    provider: string,
    utteranceId: string,
    segmentId: string | null,
  ): Promise<RepositoryResult<boolean>> {
    try {
      const result = await this.executor.query(LOAD_FINAL_BY_SOURCE_IDENTITY_SQL, [
        interviewId,
        provider,
        utteranceId,
        segmentId,
      ]);
      const parsed = parseRows(
        result.rows,
        finalizedSourceIdentityRowSchema,
        'transcript',
        `${provider}:${utteranceId}`,
      );
      if (!parsed.ok) return parsed;
      return parsed.value.length <= 1
        ? success(parsed.value.length === 1)
        : failure(
            corruptData(
              'transcript',
              `${provider}:${utteranceId}`,
              'Duplicate final segments for provider source identity',
            ),
          );
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', `${provider}:${utteranceId}`);
    }
  }

  private async validateParticipantInvariant(
    interviewId: string,
    final: FinalizedParticipantSegment,
  ): Promise<RepositoryResult<void>> {
    const aggregate = await this.loadAggregate(interviewId);
    if (!aggregate.ok) return aggregate;
    try {
      ingestFinalParticipantSegment(aggregate.value, final);
      return success(undefined);
    } catch (error: unknown) {
      return error instanceof TranscriptDomainError
        ? failure({
            code: 'constraint_violation',
            constraint: `transcript_${error.code}`,
          })
        : databaseFailure(error, 'transcript', final.turnId);
    }
  }

  private async existingResolvedTurn(
    interviewId: string,
    delivery: StoredAiDelivery,
    write: ResolvedAiTurnWrite,
  ): Promise<RepositoryResult<AiTranscriptTurn | null>> {
    if (delivery.status === 'pending') return success(null);
    if (delivery.status !== 'complete' && delivery.status !== 'interrupted') {
      return duplicateConflict('transcript', write.deliveryId);
    }
    const aggregate = await this.loadAggregate(interviewId);
    if (!aggregate.ok) return aggregate;
    const existing = aggregate.value.entries.find(
      (entry): entry is AiTranscriptTurn =>
        entry.kind === 'turn' &&
        entry.speaker === 'ai_interviewer' &&
        entry.turnId === delivery.turnId,
    );
    if (existing === undefined) {
      return failure(
        corruptData('transcript', write.deliveryId, 'Resolved AI delivery has no canonical turn'),
      );
    }
    const exact =
      sameAiTurn(existing, write.turn) &&
      delivery.provider === write.provider &&
      delivery.providerDeliveryEventId === write.providerDeliveryEventId &&
      delivery.confirmedSpokenText === write.turn.text &&
      sameNullableTimestamp(delivery.resolvedAt, write.resolvedAt) &&
      sameNullableTimestamp(
        delivery.interruptedAt,
        write.turn.delivery.status === 'interrupted' ? write.turn.delivery.interruptedAt : null,
      );
    return exact ? success(existing) : duplicateConflict('transcript', write.deliveryId);
  }

  private async existingGappedDelivery(
    interviewId: string,
    delivery: StoredAiDelivery,
    write: GappedAiDeliveryWrite,
  ): Promise<RepositoryResult<TranscriptTechnicalGap | null>> {
    if (delivery.status === 'pending') return success(null);
    if (delivery.status !== 'gapped' && delivery.status !== 'cancelled') {
      return duplicateConflict('transcript', write.deliveryId);
    }
    const aggregate = await this.loadAggregate(interviewId);
    if (!aggregate.ok) return aggregate;
    const existing = aggregate.value.entries.find(
      (entry): entry is TranscriptTechnicalGap =>
        entry.kind === 'technical_gap' && entry.sequenceNumber === delivery.reservedSequenceNumber,
    );
    if (existing === undefined) {
      return failure(
        corruptData('transcript', write.deliveryId, 'Gapped AI delivery has no canonical gap'),
      );
    }
    return delivery.status === write.status &&
      sameNullableTimestamp(delivery.resolvedAt, write.resolvedAt) &&
      sameGap(existing, write.gap)
      ? success(existing)
      : duplicateConflict('transcript', write.deliveryId);
  }

  private async lockTranscriptWrite(
    interviewId: string,
  ): Promise<RepositoryResult<z.infer<typeof transcriptWriteGuardRowSchema>>> {
    try {
      const result = await this.executor.query(LOCK_TRANSCRIPT_WRITE_SQL, [interviewId]);
      const guard = parseSingleRow(
        result.rows,
        transcriptWriteGuardRowSchema,
        'transcript',
        interviewId,
      );
      if (!guard.ok) return guard;
      const pendingShapeValid =
        (guard.value.pendingDeliveryId === null) ===
        (guard.value.pendingReservedSequenceNumber === null);
      const latestShapeValid =
        (guard.value.lastSequenceNumber === null) === (guard.value.lastOccurredAt === null);
      return pendingShapeValid && latestShapeValid
        ? guard
        : failure(corruptData('transcript', interviewId, 'Invalid transcript write guard'));
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', interviewId);
    }
  }

  private validateNewCanonicalWrite(
    guard: z.infer<typeof transcriptWriteGuardRowSchema>,
    expectedSequenceNumber: number,
    occurredAt: string,
  ): RepositoryResult<void> {
    const writable = this.validateWritable(guard);
    if (!writable.ok) return writable;
    if (guard.pendingDeliveryId !== null && guard.pendingReservedSequenceNumber !== null) {
      return failure({
        code: 'pending_ai_delivery',
        interviewId: guard.interviewId,
        deliveryId: guard.pendingDeliveryId,
        reservedSequenceNumber: guard.pendingReservedSequenceNumber,
      });
    }
    if (guard.nextSequenceNumber !== expectedSequenceNumber) {
      return failure({
        code: 'sequence_conflict',
        interviewId: guard.interviewId,
        expected: expectedSequenceNumber,
        actual: guard.nextSequenceNumber,
      });
    }
    const expectedPrevious = expectedSequenceNumber - 1;
    if ((guard.lastSequenceNumber ?? 0) !== expectedPrevious) {
      return failure(
        corruptData('transcript', guard.interviewId, 'Canonical sequence and counter diverged'),
      );
    }
    return this.validateTimestamp(guard, occurredAt);
  }

  private validateReservedCanonicalWrite(
    guard: z.infer<typeof transcriptWriteGuardRowSchema>,
    delivery: StoredAiDelivery,
    occurredAt: string,
  ): RepositoryResult<void> {
    const writable = this.validateWritable(guard);
    if (!writable.ok) return writable;
    if (
      guard.pendingDeliveryId !== delivery.deliveryId ||
      guard.pendingReservedSequenceNumber !== delivery.reservedSequenceNumber
    ) {
      return duplicateConflict('transcript', delivery.deliveryId);
    }
    if (guard.nextSequenceNumber !== delivery.reservedSequenceNumber + 1) {
      return failure(
        corruptData('transcript', guard.interviewId, 'Reserved AI sequence and counter diverged'),
      );
    }
    if ((guard.lastSequenceNumber ?? 0) !== delivery.reservedSequenceNumber - 1) {
      return failure(
        corruptData('transcript', guard.interviewId, 'Reserved AI sequence is not canonical next'),
      );
    }
    return this.validateTimestamp(guard, occurredAt);
  }

  private validateWritable(
    guard: z.infer<typeof transcriptWriteGuardRowSchema>,
  ): RepositoryResult<void> {
    return this.transcriptIsClosed(guard)
      ? failure({ code: 'transcript_finalized', interviewId: guard.interviewId })
      : success(undefined);
  }

  private transcriptIsClosed(guard: z.infer<typeof transcriptWriteGuardRowSchema>): boolean {
    return guard.status === 'completed' || guard.status === 'failed' || guard.isFinalized;
  }

  private validateTimestamp(
    guard: z.infer<typeof transcriptWriteGuardRowSchema>,
    occurredAt: string,
  ): RepositoryResult<void> {
    return guard.lastOccurredAt !== null &&
      Date.parse(occurredAt) < Date.parse(guard.lastOccurredAt)
      ? failure({ code: 'constraint_violation', constraint: 'transcript_timestamp_regression' })
      : success(undefined);
  }

  private validReservation(interviewId: string, reservation: AiDeliveryReservation): boolean {
    return (
      idSchema.safeParse(interviewId).success &&
      aiDeliveryReservationInputSchema.safeParse(reservation).success &&
      referenceMatchesTurnType(reservation.turnType, reservation.guideReference)
    );
  }

  private validResolution(delivery: StoredAiDelivery, write: ResolvedAiTurnWrite): boolean {
    const turn = write.turn;
    if (
      delivery.status !== 'pending' ||
      !canonicalTranscriptTurnSchema.safeParse(turn).success ||
      turn.speaker !== 'ai_interviewer' ||
      turn.interviewId !== delivery.interviewId ||
      turn.sequenceNumber !== delivery.reservedSequenceNumber ||
      turn.turnId !== delivery.turnId ||
      turn.turnType !== delivery.turnType ||
      !isDeepStrictEqual(turn.guideReference, delivery.guideReference) ||
      !transcriptProviderSchema.safeParse(write.provider).success ||
      !providerEventIdSchema.safeParse(write.providerDeliveryEventId).success ||
      turn.deliveryEventId !== write.providerDeliveryEventId ||
      !timestampInputSchema.safeParse(write.resolvedAt).success ||
      Date.parse(turn.occurredAt) < Date.parse(delivery.createdAt) ||
      Date.parse(write.resolvedAt) < Date.parse(turn.occurredAt)
    ) {
      return false;
    }
    if (turn.delivery.status === 'complete') return turn.text === delivery.proposedText;
    return (
      delivery.proposedText.startsWith(turn.text) &&
      Date.parse(turn.delivery.interruptedAt) >= Date.parse(turn.occurredAt) &&
      Date.parse(turn.delivery.interruptedAt) <= Date.parse(write.resolvedAt)
    );
  }

  private validGap(delivery: StoredAiDelivery, write: GappedAiDeliveryWrite): boolean {
    return (
      delivery.status === 'pending' &&
      write.gap.sequenceNumber === delivery.reservedSequenceNumber &&
      write.gap.source !== 'speech_to_text' &&
      Date.parse(write.gap.occurredAt) >= Date.parse(delivery.createdAt) &&
      Date.parse(write.resolvedAt) >= Date.parse(write.gap.occurredAt)
    );
  }

  private sameReservation(delivery: StoredAiDelivery, reservation: AiDeliveryReservation): boolean {
    return (
      delivery.deliveryId === reservation.deliveryId &&
      delivery.jobId === reservation.jobId &&
      delivery.workflowRunId === reservation.workflowRunId &&
      delivery.turnId === reservation.turnId &&
      delivery.utteranceId === reservation.utteranceId &&
      delivery.turnType === reservation.turnType &&
      isDeepStrictEqual(delivery.guideReference, reservation.guideReference) &&
      delivery.proposedText === reservation.proposedText &&
      isDeepStrictEqual(delivery.planningMetadata ?? null, reservation.planningMetadata ?? null) &&
      sameTimestamp(delivery.createdAt, reservation.createdAt)
    );
  }

  private pendingDelivery(
    interviewId: string,
    reservedSequenceNumber: number,
    reservation: AiDeliveryReservation,
  ): StoredAiDelivery {
    return {
      ...reservation,
      interviewId,
      reservedSequenceNumber,
      status: 'pending',
      provider: null,
      providerDeliveryEventId: null,
      confirmedSpokenText: null,
      resolvedAt: null,
      interruptedAt: null,
    };
  }

  private parseAiDeliveries(
    rows: readonly unknown[],
    interviewId: string,
    identity: string,
  ): RepositoryResult<readonly StoredAiDelivery[]> {
    const parsed = parseRows(rows, storedAiDeliveryRowSchema, 'transcript', identity);
    if (!parsed.ok) return parsed;
    const deliveries: StoredAiDelivery[] = [];
    for (const row of parsed.value) {
      if (row.interviewId !== interviewId) {
        return failure(corruptData('transcript', identity, 'Cross-interview AI delivery'));
      }
      const delivery = toStoredAiDelivery(row);
      if (!delivery.ok) return delivery;
      deliveries.push(delivery.value);
    }
    return success(deliveries);
  }

  private async findExistingGap(
    interviewId: string,
    gap: TranscriptTechnicalGap,
  ): Promise<RepositoryResult<TranscriptTechnicalGap | null>> {
    try {
      const result = await this.executor.query(LOAD_GAP_IDENTITIES_SQL, [
        interviewId,
        gap.gapId,
        gap.sourceEventId,
        gap.sourceProvider,
        gap.relatedUtteranceId,
        gap.relatedSegmentId,
      ]);
      const rows = parseRows(result.rows, gapIdentityRowSchema, 'transcript', gap.gapId);
      if (!rows.ok) return rows;
      if (rows.value.length === 0) return success(null);
      if (rows.value.length !== 1) return duplicateConflict('transcript', gap.gapId);
      const row = rows.value[0]!;
      const base = {
        kind: 'technical_gap',
        interviewId,
        sequenceNumber: row.sequenceNumber,
        gapId: row.gapId,
        sourceEventId: row.sourceEventId,
        description: row.description,
        occurredAt: row.occurredAt,
        relatedSegmentId: row.relatedSegmentId,
      } as const;
      let existing: TranscriptTechnicalGap;
      if (row.source === 'speech_to_text') {
        if (row.provider === null) {
          return failure(corruptData('transcript', row.gapId, 'Invalid gap provider shape'));
        }
        if (row.relatedUtteranceId === null) {
          return failure(corruptData('transcript', row.gapId, 'Invalid gap utterance shape'));
        }
        existing = {
          ...base,
          source: row.source,
          sourceProvider: row.provider,
          relatedUtteranceId: row.relatedUtteranceId,
        };
      } else {
        if (row.provider !== null || row.relatedUtteranceId !== null) {
          return failure(corruptData('transcript', row.gapId, 'Invalid gap provider shape'));
        }
        existing = {
          ...base,
          source: row.source,
          sourceProvider: null,
          relatedUtteranceId: null,
        };
      }
      return sameGap(existing, gap)
        ? success(existing)
        : duplicateConflict('transcript', gap.gapId);
    } catch (error: unknown) {
      return databaseFailure(error, 'transcript', gap.gapId);
    }
  }

  private async resolvePartials(
    interviewId: string,
    segmentId: string | null,
    disposition: 'ignored_stale' | 'ignored_finalized',
    provider: string,
    utteranceId?: string,
  ): Promise<void> {
    await this.executor.query(
      utteranceId === undefined ? RESOLVE_PARTIALS_SQL : RESOLVE_UTTERANCE_PARTIALS_SQL,
      [
        interviewId,
        segmentId,
        disposition,
        provider,
        ...(utteranceId === undefined ? [] : [utteranceId]),
      ],
    );
  }
}

export function createPostgresTranscriptRepository(executor: SqlExecutor): TranscriptRepository {
  return new PostgresTranscriptRepository(executor);
}

function duplicateConflict(resource: 'transcript', identity: string): RepositoryResult<never> {
  return failure({ code: 'duplicate_conflict', resource, identity });
}

function sameTimestamp(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function sameNullableTimestamp(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : sameTimestamp(left, right);
}

function samePartial(left: PartialTranscriptSegment, right: PartialTranscriptSegment): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.sourceProvider === right.sourceProvider &&
    left.utteranceId === right.utteranceId &&
    left.providerEventId === right.providerEventId &&
    left.segmentId === right.segmentId &&
    left.text === right.text &&
    left.revision === right.revision &&
    sameTimestamp(left.observedAt, right.observedAt)
  );
}

function sameAiTurn(left: AiTranscriptTurn, right: AiTranscriptTurn): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.sequenceNumber === right.sequenceNumber &&
    left.turnId === right.turnId &&
    left.deliveryEventId === right.deliveryEventId &&
    left.speaker === right.speaker &&
    left.turnType === right.turnType &&
    left.text === right.text &&
    sameTimestamp(left.occurredAt, right.occurredAt) &&
    isDeepStrictEqual(left.guideReference, right.guideReference) &&
    left.delivery.status === right.delivery.status &&
    (left.delivery.status === 'complete' ||
      (right.delivery.status === 'interrupted' &&
        sameTimestamp(left.delivery.interruptedAt, right.delivery.interruptedAt)))
  );
}

function sameGap(left: TranscriptTechnicalGap, right: TranscriptTechnicalGap): boolean {
  return (
    left.interviewId === right.interviewId &&
    left.sequenceNumber === right.sequenceNumber &&
    left.gapId === right.gapId &&
    left.source === right.source &&
    left.sourceProvider === right.sourceProvider &&
    left.sourceEventId === right.sourceEventId &&
    left.description === right.description &&
    sameTimestamp(left.occurredAt, right.occurredAt) &&
    left.relatedSegmentId === right.relatedSegmentId &&
    left.relatedUtteranceId === right.relatedUtteranceId
  );
}

function databaseFailure(
  error: unknown,
  resource: 'transcript',
  identity: string,
): RepositoryResult<never> {
  return failure(mapDatabaseError(error, { resource, identity }));
}
