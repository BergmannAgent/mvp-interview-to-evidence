export const INITIALIZE_COUNTER_SQL = `INSERT INTO app.interview_counters (
   interview_id, next_transcript_sequence, next_event_sequence
 )
 SELECT id, 1, 1 FROM app.interviews WHERE id = $1
 ON CONFLICT (interview_id) DO NOTHING
 RETURNING interview_id AS "interviewId"`;

export const LOAD_AGGREGATE_HEADER_SQL = `SELECT i.id AS "interviewId", i.guide_id AS "guideId",
        c.next_transcript_sequence AS "nextSequenceNumber"
   FROM app.interviews i
   JOIN app.interview_counters c ON c.interview_id = i.id
  WHERE i.id = $1`;

export const LOAD_GUIDE_QUESTIONS_SQL = `SELECT q.guide_id AS "guideId", q.id AS "questionId",
        q.section_id AS "sectionId", q.kind,
        q.main_question_id AS "mainQuestionId"
   FROM app.guide_questions q
   JOIN app.guide_sections s
     ON s.guide_id = q.guide_id AND s.id = q.section_id
   JOIN app.guide_questions m
     ON m.guide_id = q.guide_id
    AND m.id = q.main_question_id
    AND m.section_id = q.section_id
  WHERE q.guide_id = $1
  ORDER BY s.position, m.position,
           CASE WHEN q.kind = 'main_question' THEN 0 ELSE 1 END,
           q.position`;

export const LOAD_ENTRIES_SQL = `SELECT e.interview_id AS "interviewId",
       e.sequence_number AS "sequenceNumber", e.entry_id AS "entryId",
       e.kind, e.occurred_at AS "occurredAt",
       t.speaker, t.turn_type AS "turnType", t.text,
       t.guide_id AS "guideId", t.question_id AS "questionId",
       t.source_provider AS "sourceProvider",
       t.provider_event_id AS "providerEventId",
       t.source_segment_id AS "sourceSegmentId",
       t.delivery_event_id AS "deliveryEventId",
       t.delivery_status AS "deliveryStatus",
       t.interrupted_at AS "interruptedAt",
       q.kind AS "questionKind", q.section_id AS "questionSectionId",
       q.main_question_id AS "questionMainQuestionId",
       g.source AS "gapSource", g.description AS "gapDescription",
       g.provider AS "gapProvider",
       g.related_segment_id AS "relatedSegmentId",
       g.related_utterance_id AS "relatedUtteranceId",
       g.source_event_id AS "sourceEventId"
  FROM app.transcript_entries e
  LEFT JOIN app.transcript_turns t
    ON t.interview_id = e.interview_id AND t.turn_id = e.entry_id
  LEFT JOIN app.guide_questions q
    ON q.guide_id = t.guide_id AND q.id = t.question_id
  LEFT JOIN app.transcript_gaps g
    ON g.interview_id = e.interview_id AND g.gap_id = e.entry_id
 WHERE e.interview_id = $1
 ORDER BY e.sequence_number ASC`;

export const LOAD_FINALS_SQL = `SELECT f.interview_id AS "interviewId",
        f.provider AS "sourceProvider", f.provider_event_id AS "providerEventId",
        f.utterance_id AS "utteranceId", f.segment_id AS "segmentId",
        f.turn_id AS "turnId", f.text, f.observed_at AS "observedAt",
        f.finalized_at AS "finalizedAt"
   FROM app.transcript_final_segments f
   JOIN app.transcript_entries e
     ON e.interview_id = f.interview_id AND e.entry_id = f.turn_id
  WHERE f.interview_id = $1
  ORDER BY e.sequence_number ASC`;

export const LOAD_UNRESOLVED_PARTIALS_SQL = `SELECT DISTINCT ON (p.provider, p.segment_id)
        p.interview_id AS "interviewId",
        p.provider AS "sourceProvider",
        p.utterance_id AS "utteranceId",
        p.provider_event_id AS "providerEventId",
        p.segment_id AS "segmentId", p.text, p.revision,
        p.observed_at AS "observedAt"
   FROM app.transcript_partial_events p
  WHERE p.interview_id = $1
    AND p.disposition IN ('accepted', 'updated')
    AND NOT EXISTS (
      SELECT 1 FROM app.transcript_final_segments f
       WHERE f.interview_id = p.interview_id
         AND f.provider = p.provider
         AND (f.segment_id = p.segment_id OR f.utterance_id = p.utterance_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.transcript_gaps g
       WHERE g.interview_id = p.interview_id
         AND g.source = 'speech_to_text'
         AND g.provider = p.provider
         AND (g.related_segment_id = p.segment_id
           OR g.related_utterance_id = p.utterance_id)
    )
  ORDER BY p.provider, p.segment_id, p.revision DESC, p.observed_at DESC`;

export const LOCK_TRANSCRIPT_WRITE_SQL = `SELECT
       st.interview_id AS "interviewId", st.status,
       c.next_transcript_sequence AS "nextSequenceNumber",
       EXISTS (
         SELECT 1 FROM app.transcript_finalizations f
          WHERE f.interview_id = st.interview_id
       ) AS "isFinalized",
       pending.id AS "pendingDeliveryId",
       pending.reserved_sequence_number AS "pendingReservedSequenceNumber",
       latest.sequence_number AS "lastSequenceNumber",
       latest.occurred_at AS "lastOccurredAt"
  FROM app.interview_state st
  JOIN app.interview_counters c ON c.interview_id = st.interview_id
  LEFT JOIN LATERAL (
    SELECT d.id, d.reserved_sequence_number
      FROM app.ai_turn_deliveries d
     WHERE d.interview_id = st.interview_id AND d.status = 'pending'
     LIMIT 1
  ) pending ON true
  LEFT JOIN LATERAL (
    SELECT e.sequence_number, e.occurred_at
      FROM app.transcript_entries e
     WHERE e.interview_id = st.interview_id
     ORDER BY e.sequence_number DESC
     LIMIT 1
  ) latest ON true
 WHERE st.interview_id = $1
 FOR UPDATE OF st, c`;

export const LOCK_AGGREGATE_SQL = LOCK_TRANSCRIPT_WRITE_SQL;

export const LOAD_PARTIAL_BY_EVENT_SQL = `SELECT interview_id AS "interviewId", provider,
        provider AS "sourceProvider",
        utterance_id AS "utteranceId", provider_event_id AS "providerEventId",
        segment_id AS "segmentId", text, revision, disposition,
        observed_at AS "observedAt"
   FROM app.transcript_partial_events
  WHERE interview_id = $1 AND provider = $2 AND provider_event_id = $3`;

export const LOAD_SEGMENT_RESOLUTION_SQL = `SELECT (
          SELECT f.segment_id
            FROM app.transcript_final_segments f
           WHERE f.interview_id = $1 AND f.provider = $2
             AND f.provider_event_id = $4
        ) AS "providerEventFinalSegmentId",
        EXISTS (
          SELECT 1 FROM app.transcript_final_segments f
           WHERE f.interview_id = $1 AND f.provider = $2
             AND (f.segment_id = $3 OR f.utterance_id = $5)
        ) AS "isFinalized",
        EXISTS (
          SELECT 1 FROM app.transcript_gaps g
           WHERE g.interview_id = $1 AND g.source = 'speech_to_text'
             AND g.provider = $2
             AND (g.related_segment_id = $3 OR g.related_utterance_id = $5)
        ) AS "hasGap"`;

export const LOAD_LATEST_PARTIAL_SQL = `SELECT p.interview_id AS "interviewId", p.provider,
        p.provider AS "sourceProvider",
        p.utterance_id AS "utteranceId",
        p.provider_event_id AS "providerEventId",
        p.segment_id AS "segmentId", p.text, p.revision, p.disposition,
        p.observed_at AS "observedAt"
   FROM app.transcript_partial_events p
  WHERE p.interview_id = $1 AND p.provider = $2 AND p.segment_id = $3
  ORDER BY p.revision DESC, p.observed_at DESC
  LIMIT 1`;

export const MARK_PROVIDER_PARTIALS_STALE_SQL = `UPDATE app.transcript_partial_events
    SET disposition = 'ignored_stale'
  WHERE interview_id = $1 AND provider = $2 AND segment_id = $3
    AND disposition IN ('accepted', 'updated')`;

export const INSERT_PARTICIPANT_TURN_SQL = `INSERT INTO app.transcript_turns (
   interview_id, turn_id, entry_kind, speaker, turn_type, text,
   guide_id, question_id, source_provider, provider_event_id, source_segment_id
 ) VALUES ($1, $2, 'turn', 'participant', 'participant_answer', $3,
           $4, $5, $6, $7, $8)`;

export const INSERT_FINAL_SEGMENT_SQL = `INSERT INTO app.transcript_final_segments (
   interview_id, provider, provider_event_id, segment_id, utterance_id,
   turn_id, text, observed_at, finalized_at
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export const INSERT_PENDING_AI_DELIVERY_SQL = `INSERT INTO app.ai_turn_deliveries (
   id, interview_id, job_id, workflow_run_id, turn_id, utterance_id,
   reserved_sequence_number, turn_type, guide_id, question_id,
   proposed_text, status, created_at, planning_metadata
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, 'pending', $12, $13::jsonb)`;

export const RESOLVE_AI_DELIVERY_SQL = `UPDATE app.ai_turn_deliveries
   SET status = $3, provider = $4, provider_delivery_event_id = $5,
       confirmed_spoken_text = $6, resolved_at = $7, interrupted_at = $8
 WHERE interview_id = $1 AND id = $2 AND status = 'pending'
 RETURNING id AS "deliveryId"`;

export const GAP_AI_DELIVERY_SQL = `UPDATE app.ai_turn_deliveries
   SET status = $3, resolved_at = $4
 WHERE interview_id = $1 AND id = $2 AND status = 'pending'
 RETURNING id AS "deliveryId"`;

export const INSERT_AI_TURN_SQL = `INSERT INTO app.transcript_turns (
   interview_id, turn_id, entry_kind, speaker, turn_type, text,
   guide_id, question_id, delivery_id, delivery_event_id,
   delivery_status, interrupted_at
 ) VALUES ($1, $2, 'turn', 'ai_interviewer', $3, $4,
           $5, $6, $7, $8, $9, $10)`;

export const INSERT_TECHNICAL_GAP_SQL = `INSERT INTO app.transcript_gaps (
   interview_id, gap_id, entry_kind, source, provider, description,
   related_segment_id, related_utterance_id, source_event_id
 ) VALUES ($1, $2, 'technical_gap', $3, $4, $5, $6, $7, $8)`;

export const LOAD_GAP_IDENTITIES_SQL = `SELECT g.gap_id AS "gapId", g.provider,
        g.source, g.description, g.related_segment_id AS "relatedSegmentId",
        g.related_utterance_id AS "relatedUtteranceId",
        g.source_event_id AS "sourceEventId", e.sequence_number AS "sequenceNumber",
        e.occurred_at AS "occurredAt"
   FROM app.transcript_gaps g
   JOIN app.transcript_entries e
     ON e.interview_id = g.interview_id AND e.entry_id = g.gap_id
  WHERE g.interview_id = $1
    AND (g.gap_id = $2 OR (
      g.source_event_id = $3 AND (
        (g.source = 'speech_to_text' AND g.provider = $4)
        OR (g.source <> 'speech_to_text' AND $4::text IS NULL)
      )
    ) OR (g.source = 'speech_to_text' AND g.provider = $4
      AND (g.related_utterance_id = $5
        OR ($6::text IS NOT NULL AND g.related_segment_id = $6))))
  ORDER BY g.gap_id`;

export const LOAD_STT_GAP_BY_SOURCE_IDENTITY_SQL = `SELECT gap_id AS "gapId"
   FROM app.transcript_gaps
  WHERE interview_id = $1 AND source = 'speech_to_text'
    AND provider = $2
    AND (related_utterance_id = $3
      OR ($4::text IS NOT NULL AND related_segment_id = $4))`;

export const LOAD_FINAL_BY_SOURCE_IDENTITY_SQL = `SELECT turn_id AS "turnId"
   FROM app.transcript_final_segments
  WHERE interview_id = $1 AND provider = $2
    AND (utterance_id = $3 OR ($4::text IS NOT NULL AND segment_id = $4))`;

export const ALLOCATE_TRANSCRIPT_SEQUENCE_SQL = `UPDATE app.interview_counters
    SET next_transcript_sequence = next_transcript_sequence + 1
  WHERE interview_id = $1 AND next_transcript_sequence = $2
  RETURNING next_transcript_sequence - 1 AS "allocatedSequence"`;

export const LOAD_CURRENT_SEQUENCE_SQL = `SELECT next_transcript_sequence AS "nextSequenceNumber"
   FROM app.interview_counters WHERE interview_id = $1`;

export const INSERT_TRANSCRIPT_ENTRY_SQL = `INSERT INTO app.transcript_entries (
   interview_id, sequence_number, entry_id, kind, occurred_at
 ) VALUES ($1, $2, $3, $4, $5)`;

export const INSERT_PARTIAL_SQL = `INSERT INTO app.transcript_partial_events (
   interview_id, provider, provider_event_id, segment_id, utterance_id,
   revision, text, disposition, observed_at
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export const BUMP_TRANSCRIPT_MUTATION_VERSION_SQL = `UPDATE app.interview_counters
    SET transcript_mutation_version = transcript_mutation_version + 1
  WHERE interview_id = $1
  RETURNING transcript_mutation_version AS "transcriptMutationVersion"`;

export const LOAD_FINAL_IDENTITIES_SQL = `SELECT provider,
        utterance_id AS "utteranceId", provider_event_id AS "providerEventId",
        segment_id AS "segmentId", turn_id AS "turnId"
   FROM app.transcript_final_segments
  WHERE interview_id = $1
    AND ((provider = $2 AND utterance_id = $3)
      OR (provider = $2 AND provider_event_id = $4)
      OR (provider = $2 AND segment_id = $5)
      OR turn_id = $6)
  ORDER BY turn_id`;

export const AI_DELIVERY_PROJECTION = `d.interview_id AS "interviewId",
        d.id AS "deliveryId", d.job_id AS "jobId",
        d.workflow_run_id AS "workflowRunId", d.turn_id AS "turnId",
        d.utterance_id AS "utteranceId",
        d.reserved_sequence_number AS "reservedSequenceNumber",
        d.turn_type AS "turnType", d.guide_id AS "guideId",
        d.question_id AS "questionId", q.kind AS "questionKind",
        q.section_id AS "questionSectionId",
        q.main_question_id AS "questionMainQuestionId",
        d.proposed_text AS "proposedText", d.planning_metadata AS "planningMetadata",
        d.status, d.provider,
        d.provider_delivery_event_id AS "providerDeliveryEventId",
        d.confirmed_spoken_text AS "confirmedSpokenText",
        d.created_at AS "createdAt", d.resolved_at AS "resolvedAt",
        d.interrupted_at AS "interruptedAt"`;

export const LOAD_AI_DELIVERY_SQL = `SELECT ${AI_DELIVERY_PROJECTION}
   FROM app.ai_turn_deliveries d
   LEFT JOIN app.guide_questions q
     ON q.guide_id = d.guide_id AND q.id = d.question_id
  WHERE d.interview_id = $1 AND d.id = $2`;

export const LOAD_AI_DELIVERY_IDENTITIES_SQL = `SELECT ${AI_DELIVERY_PROJECTION}
   FROM app.ai_turn_deliveries d
   LEFT JOIN app.guide_questions q
     ON q.guide_id = d.guide_id AND q.id = d.question_id
  WHERE d.interview_id = $1
    AND (d.id = $2 OR d.turn_id = $3 OR d.utterance_id = $4)
  ORDER BY d.id`;

export const LOAD_PENDING_AI_DELIVERIES_SQL = `SELECT ${AI_DELIVERY_PROJECTION}
   FROM app.ai_turn_deliveries d
   LEFT JOIN app.guide_questions q
     ON q.guide_id = d.guide_id AND q.id = d.question_id
  WHERE d.interview_id = $1 AND d.status = 'pending'
  ORDER BY d.reserved_sequence_number`;

export const LOAD_QUESTION_AI_DELIVERIES_SQL = `SELECT ${AI_DELIVERY_PROJECTION}
   FROM app.ai_turn_deliveries d
   LEFT JOIN app.guide_questions q
     ON q.guide_id = d.guide_id AND q.id = d.question_id
  WHERE d.interview_id = $1 AND d.question_id = $2
  ORDER BY d.reserved_sequence_number`;

export const RESOLVE_PARTIALS_SQL = `UPDATE app.transcript_partial_events
    SET disposition = $3
  WHERE interview_id = $1 AND segment_id = $2
    AND provider = $4
    AND disposition IN ('accepted', 'updated')`;

export const RESOLVE_UTTERANCE_PARTIALS_SQL = `UPDATE app.transcript_partial_events
    SET disposition = $3
  WHERE interview_id = $1 AND provider = $4
    AND (segment_id = $2 OR utterance_id = $5)
    AND disposition IN ('accepted', 'updated')`;
