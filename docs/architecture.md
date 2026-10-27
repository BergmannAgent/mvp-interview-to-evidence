# MVP Architecture

## Runtime Topology

Docker Compose exposes one application through these services:

1. `postgres`: PostgreSQL 17.9 with a named persistent volume.
2. `migrations`: one-shot, versioned application-schema migration runner.
3. `backend`: Hono API, PostgreSQL persistence, SSE bridge, and the server-side
   OpenAI Realtime client-secret endpoint.
4. `interview`: production static React application.
5. `monitoring`: separate production static React application.
6. `evaluation-studio`: separate profile administration and post-interview
   evaluation application.

Compose waits for `postgres: service_healthy`, runs `migrations`, starts `backend`
after that one-shot succeeds, and starts all three frontends after the backend is
healthy. Readiness verifies the expected application migration version before
accepting traffic. Compose publishes the three frontends on ports 5273, 5274, and
5275 respectively.

Mastra agents and workflows execute inside the backend service, so Compose needs
no separate worker for the local MVP. Voice connects the interview browser
directly to OpenAI over WebRTC. It requires `OPENAI_API_KEY`; text mode remains an
independently selected development mode. Missing credentials produce an explicit
Voice error, and Voice has no fallback provider.

## Workspace Boundaries

- `packages/contracts`: Zod schemas and inferred types for API, realtime events,
  transcript, guide, agents, workflow, errors, and the versioned literature
  instrument. It has no framework or DOM types.
- `packages/domain`: deterministic parser, state machine, coverage projection,
  transcript invariants, validation policies, and ports. It cannot import React,
  Hono, database drivers, WebSockets, voice, Mastra, or model providers.
- `packages/api-client`: browser-specific validated HTTP and SSE client shared by
  the three frontends.
- `packages/design-tokens`: platform-neutral colors, typography, spacing, motion,
  and status tokens; the three applications retain independent layouts.
- `apps/backend`: application services, Drizzle repositories, Hono transport,
  Mastra agent definitions, provider adapters, outbox, and export renderers.
- `apps/interview`: participant media and meeting experience.
- `apps/monitoring`: read-only operational dashboard.
- `apps/evaluation-studio`: profile administration, import preview, explicit
  post-interview evaluation runner, and generic report inspection.

Dependencies point inward: transport and infrastructure depend on application
services and domain ports; the domain never depends on infrastructure. Node-facing
projects use NodeNext ESM resolution and explicit `.js` relative imports. Only Vite
frontends and the browser API client use Bundler resolution and DOM libraries.

## Data Ownership And Initialization

PostgreSQL currently initializes the `app` schema:

- `app`: guides, questions, interviews, state, transcript segments and turns,
  coverage, contradictions, workflow jobs, workflow/agent run projections, event
  outbox, finalization records, evaluation profiles, and profile-scoped evaluation
  reports. Drizzle migrations are checked into Git.

Canonical research data belongs to `app`; Mastra data is not the canonical
transcript or monitoring history. A separate Mastra storage schema was part of the
original target architecture but is not initialized as a separate Compose step in
the current Fast MVP.

The repository owns three versioned research artifacts under
`research/instruments/organizational-resilience/`: the nine-item
`kantur-iseri-say-evidence-v1.json` instrument, the derived intermediate-value
codebook, and the `resilient-decision-processes-guide-mapping-v1.json` guide
mapping. Zod validates all three artifacts and their canonical SHA-256 sidecars at
backend startup. The backend image contains the same files, so local Node execution
and Docker use identical versions. The published 1-to-5 self-report scale and the
prototype's derived 1-to-7 evidence rating are separate measurement forms.

`evaluation_profiles` stores validated, guide- and language-independent 1-to-7
profile documents. Exactly one row is marked `default`; the application seeds it
idempotently from the former Organizational-Resilience configuration. The selected
profile content and all anchors are snapshotted into each completed report.

Migration 0012 intentionally removes incompatible prototype evaluation runs and
rubrics, then creates one current run identity per interview/profile pair. Profile
and finalized-transcript fingerprints fence stale results while prompt and model
versions remain explicit report provenance. This one-time reset leaves canonical
interviews, transcript turns, and profiles unchanged. Repeated reads are read-only;
start and retry are explicit commands with compare-and-swap attempt ownership.

Per-interview counters are rows updated under `SELECT ... FOR UPDATE` inside the
same short transaction that writes a turn or event. Unique constraints on
`(interview_id, sequence_number)`, provider message IDs, and idempotency keys
prevent duplicates and cross-interview mixing.

## Persisted Turn Processing

Both modalities enter the canonical interview application service. Text answers
use stable client event IDs, and final Voice transcription events use their OpenAI
item ID as the idempotency key. The exact final participant text and its outbox
events commit before any probabilistic planning. Neither the browser nor a model
can write interview state directly.

Lifecycle commands, participant turns, workflow/run projections, delivery
reservations, and outbox events use the same transactional repositories. Job and
lease records remain part of that persistence model, but the current backend has no
background worker or lease-reclamation loop. Request handlers enqueue, claim, and
complete the lifecycle or turn record synchronously. Repository operations for a
future worker are tested but are not an active recovery mechanism in this snapshot.

The active Voice path is:

1. Persist the final participant transcription exactly once.
2. Ask the existing Realtime session for one structured `plan_interview_turn`
   tool result without producing audio.
3. Validate that intent against the persisted guide, current coverage, latest final
   answer, and prior clarification turns.
4. Atomically update state and reserve exactly one canonical AI delivery.
5. Ask Realtime to speak only the approved text and persist the AI turn after the
   provider transcript matches the reservation.

When the validated next turn is the first main question of a different parsed
guide section, the same state transaction appends one immutable `SectionMemory`.
The memory contains only guide-scoped coverage plus verbatim participant evidence
with canonical turn IDs; it never replaces transcript rows and is never used by
evaluation or export. The Realtime prompt retains the full current section, the
latest four canonical turns, and memories for older sections. In an existing
WebRTC session the browser first waits for `session.updated`, then deletes only
provider conversation items it observed in that session. A compactor timeout,
invalid memory, missing acknowledgement, or rejected maintenance event leaves the
raw provider context in place and does not stop the interview. Reconnect builds
the same compact context from persisted memories.

The active Text path is different. After the participant turn commits, a Mastra
workflow runs Coverage and Consistency in parallel, then Interview Decision and
Interview Conductor. Structured outputs and references are validated before the
result updates coverage and reserves the next AI turn. The request waits for this
workflow; it is not handed to a production background worker.

Start and completion also execute synchronously. Start changes lifecycle and
coverage and reserves a greeting delivery. The separately selected Text mode
resolves reserved deliveries immediately as text; Voice plays and confirms them
through Realtime. Completion converts unresolved deliveries and partial
transcriptions into explicit technical gaps, reserves a closing, and finalizes only
after that closing is resolved. Duplicate commands and provider events return the
already persisted result where their idempotency identity matches.

## Canonical Transcript

Partial STT segments are transient records for captions and monitoring. They are
never transcript turns. A final provider event becomes one immutable participant
turn. Late partial events cannot modify it.

Text mode immediately finalizes its validated AI utterance. In Voice mode,
OpenAI Realtime transcript completion events provide the actual AI text. The
frontend publishes an AI turn only after the corresponding Realtime response has
completed successfully, using the provider item ID for idempotency. Incomplete,
failed, or cancelled responses are not persisted as completed AI turns.

An unresolved reserved AI delivery blocks normal next-answer finalization until a
playout, interruption, explicit gap, or interview-completion event resolves it.
Reconnect reloads authoritative pending state. The current backend has no timer
worker that automatically turns an abandoned delivery into a gap.

Markdown, JSON, and plain-text exports are pure renderers over the same canonical
turn query used by all three frontends. Deterministic finalization first verifies
sequence, speakers, references, gaps, and delivery state. A read-only Mastra
Transcript Finalization Agent then emits a strict report containing only turn IDs,
gap IDs, and validation findings. It cannot return replacement transcript text or
write turns. Its references are deterministically validated before the report is
stored; exports always use unchanged canonical rows.

## Realtime And Recovery

Application realtime uses server-sent events because monitoring and transcript
updates are server-to-client, ordered, and read-only. Every persisted event has a
UUID, interview ID, run ID, per-interview sequence, timestamp, category, and
validated payload.

PostgreSQL outbox rows are inserted in the same transaction as their domain change.
The backend maintains a committed `LISTEN` connection plus periodic table polling
as recovery. For a new SSE client it subscribes to wake-up signals, captures a
database high-water sequence, and replays persisted rows in strict sequence. The
in-memory hub coalesces interview wake-ups only; it is not an event buffer and
never replaces database replay. `Last-Event-ID` and `afterSequence` both resume
after the last delivered sequence. Slow clients are disconnected without blocking
workflow commits; multiple tabs have independent streams.

The monitoring snapshot includes its `eventSequence` high-water mark. A client
applies the snapshot, opens SSE with `afterSequence=eventSequence`, and accepts
only strictly newer events whose interview ID matches the active selection. Every
selection change increments a local connection generation so late events from the
old interview are discarded. This makes snapshot bootstrap, refresh, reconnect,
and rapid interview switching deterministic.

Stable application job IDs, workflow IDs, database constraints, and transactional
outbox writes provide request-level idempotency and audit records. Although the
repository exposes lease reclaim operations, the current production composition
does not call them at startup or periodically. Automatic crash resumption of an
in-flight Mastra request is therefore an explicit MVP limitation.

Mastra agent calls use bounded structured generation and tracing options that hide
provider input and output. The current runtime does not stream `fullStream` events
into the outbox and does not install a PostgreSQL trace exporter. The dashboard
receives application-authored, schema-validated run inputs, outputs, rationale,
references, validation, timing, retry, and error records; it does not expose hidden
model reasoning.

## API Shape

- `/health/live` and `/health/ready` for process and dependency checks.
- `/api/v1/guides` for validated Markdown upload and parsed structure.
- `/api/v1/interviews` for creation and listing; interview detail and session routes
  expose state plus the canonical transcript read model.
- `/api/v1/interviews/:id/start|pause|resume|end` and `/turns` for the separately
  selected Text mode and synchronous lifecycle processing.
- `/api/v1/interviews/:id/partial-transcript` for live partial captions.
- `/api/v1/interviews/:id/events`, `/event-history`, and `/monitoring` for SSE,
  persisted replay, and the current monitoring read model.
- `/api/v1/interviews/:id/voice/session` for a short-lived OpenAI Realtime client
  secret and interview-scoped session instructions.
- `/api/v1/interviews/:id/realtime/start`, `/realtime/participant-turns`,
  `/realtime/turn-intents`, `/realtime/recover-participant-turn`,
  `/realtime/ai-turns`, `/realtime/ai-turns/interrupted`, `/realtime/gaps`,
  `/realtime/pending-plan`, and `/realtime/complete` for the active Voice lifecycle
  and explicit recovery.
- `/api/v1/evaluation-profiles`, `/templates`, and `/imports` for profile CRUD,
  guardrail metadata, generic JSON/XLSX templates, preview, confirmation, and JSON
  export.
- `/api/v1/interviews/:id/evaluation`, `/evaluation/retry`, and
  `/evaluation/export` for explicit profile-selected coding and JSON, CSV,
  Markdown, or HTML output.

The current backend has no public Mastra server route and no backend transcript
export endpoint. Interview transcript files are rendered in the Interview frontend
from the canonical session response; Evaluation exports are rendered server-side
from the persisted evaluation report.

All request bodies, params, query strings, responses, and SSE payloads are parsed
with shared Zod schemas. Errors use a stable `{ error: { code, message, requestId,
occurredAt, retryable, fieldErrors } }` envelope. Browser mutations pass an
explicit pre-parser Origin allowlist in addition to CORS response headers;
originless local service and CLI requests remain supported. Multipart and JSON
bodies are bounded before parsing, and guide structure cardinality plus validation
diagnostics have independent limits. The monitoring application exposes no
mutation controls.

Liveness is process-local. Readiness has an application deadline and requires the
exact migrated application schema version. Runtime shutdown uses one absolute
deadline across HTTP draining and database closure; after that deadline, tracked
PostgreSQL clients are terminated best-effort so container shutdown cannot wait
forever on a checked-out connection. Idle PostgreSQL client errors emit only
redacted structured diagnostics and do not become unhandled process errors.

## Voice

The Voice path is a native speech-to-speech OpenAI Realtime session with
`gpt-realtime-2.1`. The backend builds renderer-only instructions and creates a
short-lived, session-scoped client secret. The durable
`OPENAI_API_KEY` never leaves the backend. The interview browser uses the ephemeral
secret to connect its microphone and remote audio directly to OpenAI over WebRTC;
there is no LiveKit hop and no separate speech synthesis request.

`gpt-live-transcribe` runs inside that Realtime session and emits participant
transcript deltas and completion events. Semantic VAD uses
`eagerness: low`, `create_response: false`, and `interrupt_response: false`:
OpenAI allows deliberate pauses in expert answers and does not automatically
generate or interrupt an answer. During AI playback the microphone track remains
blocked to prevent speaker echo from cancelling and replaying the same question.
The frontend first persists the final participant
transcript with the provider item ID, waits for that request to succeed, and only
then asks the running Realtime session for one structured turn decision. The
backend maps that decision to a canonical guide question and reserves it before
the browser sends the audio `response.create`. This ordering keeps the canonical
participant turn ahead of the AI response and prevents an unpersisted answer from
advancing the interview.

The same Realtime tool call classifies the latest answer and, only for a partial
answer, may propose one clarification naming a concrete missing aspect and evidence
type. The server preserves an accepted clarification verbatim, rejects generic or
repeated wording, checks the requested aspect against the current guide topic and
latest answer, derives the single-clarification budget from canonical transcript
turns, and advances after refusals, missing knowledge, non-applicability, or
already-answered feedback. Short duration and count answers are checked relative
to their guide question rather than by a global word-count rule.

After the turn reservation succeeds, the browser sends `response.create` for the
exact server-approved text. It displays AI transcript deltas while audio is generated.
Once the Realtime response has completed successfully, it persists the actual AI
provider item ID only after its transcript matches the server-approved utterance
under a comparison that ignores case, diacritics, German umlaut transliteration,
punctuation, and whitespace; the canonical approved text is then persisted. This
checks normalized textual equivalence, not byte-identical provider transcription.
Realtime responses are correlated by the exact client request ID, and one invalid
tool call receives one bounded repair attempt.
Slow or stalled audio triggers an authoritative reconnect. A terminal utterance
mismatch restores the answered question before replanning so the session does not
remain on an unspoken turn. WebRTC, media tracks, the data channel, and
remote audio are closed on disconnect. Missing credentials and provider failures
are explicit errors; Voice has no provider, browser speech, or text fallback. The
separately selected text mode is an independent interview mode. The AI interviewer
is visibly and audibly disclosed.

## Profile-Driven Post-Interview Evaluation

Evaluation is outside the Realtime interview path. An operator independently selects
any stored profile and an interview with confirmed interviewer and participant turns,
including incomplete interviews. The report records source completeness. Merely
reading a result never starts a model call.

One bounded Mastra coding call receives immutable system guardrails, the editable
domain prompt and subject-matter profile snapshot, plus only final participant turns from
the canonical transcript. The guide and interview language do not authorize or
restrict a profile. Every item returns exactly one of `scored`,
`insufficient_evidence`, `not_applicable`, or `conflicting`; non-score states keep a
`null` score. Scored items must select one of the profile's exact anchors 1 through 7.
The active profile coder uses exactly two evidence directions: supporting and counter.
Entries are simply evidence, without direct/indirect classifications. Grounded
contextual and cross-answer indicators remain valid with a short explanation when
needed, and exact additional quotations when an explanation depends on multiple turns.
There is no third ambiguous-evidence category and no citation quota. Unresolved
interpretations belong in missing-information notes or rationale, not forced evidence.
New reports use schema version 5 and prompt version `profile-evidence-coding-v7`.
Profile item justifications allow up to 4000 characters and report synthesis up
to 3000, without changing the 800-character limit on interview-agent rationales.
Justifications explain evidence, anchor fit, counter-evidence and uncertainty;
they are reader-facing audit explanations, never private model reasoning. Sparse
evidence permits shorter text. Existing reports are not rewritten automatically.
The strict provider schema rejects evidenceType. Historical report types are accepted
only for compatibility, hidden in both frontends, and omitted from every export.
Historical version-3 and version-4 database reports are retained unchanged and projected read-only
into the two-direction display/export with a legacy notice. Formerly unassigned
citations are not silently reclassified; a new coding run requires user action.

The model output is never trusted as a report directly. A deterministic audit
requires every quote to be an exact substring of its referenced final participant
turn and verifies interview, turn, sequence, item, dimension, score, status, and
anchor consistency. Invalid output produces a controlled retryable failure rather
than a partially accepted report. A pure builder computes dimension and overall
aggregates server-side with the shared calculation engine. In weighted-average mode,
each scored item's coefficient is its item weight times its dimension weight; missing
scores and zero coefficients are excluded and remaining coefficients renormalized.
Dimension means use item weights only. All weights default to one, reproducing the
legacy flat item mean even for uneven dimension sizes. No positive scored coefficient
means no weighted result; coverage counts remain independent from calculation success.

Profiles can alternatively define a mathematical expression referencing stable item,
dimension and weight IDs. Missing item/dimension values become zero only inside this
expression, never in the original item assessment. A jsep 1.4.0 AST allowlist evaluates
the permitted arithmetic and functions without JavaScript execution or object access.
Results can be any finite number; division by zero and other runtime failures preserve
item results and produce an explicit calculation error. Intermediate values stay
unrounded; displayed aggregates round to two decimal places. The engine is shared by
the backend, report validation and local editor preview; it never calls an LLM.

Weights and formulas are excluded from the coder input. Version-2 JSON/XLSX profiles
carry calculation settings; strict version-1 imports retain default semantics. Report
snapshots contain exact configuration, coefficients, exclusions and evaluated formula
references. Default-equivalent settings retain the old profile fingerprint; meaningful
calculation changes invalidate the current result without automatically rescoring it.

The completed generic report snapshots its exact profile and provenance and is the
single source for the Evaluation Studio and JSON, CSV, Markdown, and HTML exports.
Monitoring remains read-only and is not a configuration surface. The initial
`default` profile retains the former OR research configuration for continuity, but
the runtime contains no special guide, language, dimension, or item-ID path.

## Operational Limits

- The MVP is local and single-tenant; authentication and authorization are outside
  scope.
- One backend replica is supported. PostgreSQL remains the durable replay source.
- Model decisions are advisory only and constrained by deterministic validators.
- The 1-to-7 coding scale is configurable evidence coding, not automatically a
  validated measurement instrument. Each profile requires its own content,
  interrater, and psychometric validation before substantive use.
- A report reflects one participant's transcript evidence and is not an
  organization-level ground truth. No cutoffs or good/bad classifications exist.
- Profiles are intentionally independent from guides and languages. The Studio has
  no profile history, publish workflow, authentication, or model/provider settings;
  it supports only the versioned generic JSON and XLSX import formats.
- Coder agreement is not measured in the runtime prototype. Weighted Kappa and ICC
  require a later blinded double-coding dataset and are not inferred from one model
  run.
- Audio recordings are not persisted; only transcript evidence and delivery
  metadata are stored.
