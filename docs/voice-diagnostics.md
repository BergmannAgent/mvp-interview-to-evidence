# Voice diagnostics

Browser Realtime errors do not automatically appear in Docker logs: the WebRTC
connection runs directly between the browser and the provider.

The interview frontend now reports `error`, failed/incomplete `response.done`,
failed input transcription, and local voice failures to
`POST /api/v1/interviews/:interviewId/realtime/diagnostics`.

Each report carries a diagnostic UUID, client timestamp, source, event type, error
code/type, provider event ID and response ID when available, and a bounded,
sanitized error message. No complete provider events, audio, prompts, conversation
items or stack traces are forwarded. Common credential formats, bearer tokens,
URLs and quoted values in provider messages are redacted. Free-text provider
messages are diagnostic data and should still be treated as potentially sensitive.

The backend validates and sanitizes the report again, checks the interview exists,
and persists it as an `error.occurred` event with `payload.source = voice` and
`payload.diagnostic`. Existing outbox sequencing, replay, database volumes, and
monitoring error filters apply. The transcript and interview lifecycle are not
modified. After persistence the backend writes a JSON `voice.diagnostic` log:

```sh
docker compose logs --since 15m backend | rg 'voice.diagnostic'
```

Reports are best-effort, do not block turn-taking, time out after five seconds,
and are bounded to 30 per minute per mounted interview app. Transport failures
produce a browser warning containing only the diagnostic ID, with no recursive
reporting. An unavailable backend can therefore still lose diagnostic events.
Client and provider reports may describe the same failure from different layers.

Reload the interview and monitoring browser tabs after deployment. Earlier errors
cannot be reconstructed from this new logging. The 2026-09-19 interview
`b66df2cd-0415-4dab-ad2a-60a6820f74e0` had three stored audio gaps but no retained
provider error detail; backend/Postgres Docker logs contained no matching error.

Scope checkpoint: reuse the existing monitoring outbox; no new logging service,
database migration, interview retry policy change or transcript modification.
Focused verification covers extraction, redaction, payload validation, HTTP
ingestion and existing voice-event handling.

Verified on 2026-09-19: 85 focused tests, lint, TypeScript checks and Docker builds
passed. A disposable interview received the same diagnostic twice (HTTP 204),
retained exactly one error event, returned valid event-history JSON, and emitted
sanitized Docker logs. The disposable interview was removed after verification;
existing interviews were not modified. No live provider failure was induced.
