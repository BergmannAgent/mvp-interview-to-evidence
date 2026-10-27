import {
  apiErrorEnvelopeSchema,
  interviewSummaryPageSchema,
  mvpInterviewSessionSchema,
  monitoringEventHistoryPageSchema,
  monitoringEventSchema,
  monitoringSnapshotResponseSchema,
  monitoringStreamFaultSchema,
  monitoringStreamReadySchema,
  profileEvaluationSnapshotResponseSchema,
  type ApiErrorEnvelope,
  type InterviewSummary,
  type MvpInterviewSession,
  type MonitoringEvent,
  type MonitoringSnapshot,
  type MonitoringStreamFault,
  type MonitoringStreamReady,
  type ProfileEvaluationExportFormat,
  type ProfileEvaluationSnapshot,
} from '@orgscience/contracts';

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

interface MonitoringStreamHandlers {
  onEvent(event: MonitoringEvent): void;
  onFault(fault: MonitoringStreamFault): void;
  onReady(ready: MonitoringStreamReady): void;
  onConnectionError(): void;
}

const apiBaseUrl = (import.meta.env['VITE_API_BASE_URL'] ?? '').replace(/\/$/u, '');

export class MonitoringApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'NETWORK_ERROR', retryable = true) {
    super(message);
    this.name = 'MonitoringApiError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface EvaluationExportFile {
  readonly blob: Blob;
  readonly fileName: string;
}

export async function listAllInterviews(signal?: AbortSignal): Promise<InterviewSummary[]> {
  const interviews: InterviewSummary[] = [];
  let after: string | null = null;

  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after !== null) query.set('after', after);
    const page = await fetchParsed(
      `/api/v1/interviews?${query.toString()}`,
      interviewSummaryPageSchema,
      signal,
    );
    interviews.push(...page.interviews);
    after = page.nextCursor;
  } while (after !== null);

  return interviews;
}

export async function getInterviewSession(
  interviewId: string,
  signal?: AbortSignal,
): Promise<MvpInterviewSession> {
  return fetchParsed(
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/session`,
    mvpInterviewSessionSchema,
    signal,
  );
}

export async function getEvaluation(
  interviewId: string,
  profileId?: string,
  signal?: AbortSignal,
): Promise<ProfileEvaluationSnapshot> {
  const query = new URLSearchParams();
  if (profileId !== undefined) query.set('profileId', profileId);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const response = await fetchParsed(
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/evaluation${suffix}`,
    profileEvaluationSnapshotResponseSchema,
    signal,
  );
  return response.evaluation;
}

export async function getEvaluationExport(
  interviewId: string,
  format: ProfileEvaluationExportFormat,
  profileId?: string,
  signal?: AbortSignal,
): Promise<EvaluationExportFile> {
  let response: Response;
  try {
    response = await fetch(evaluationExportUrl(interviewId, format, profileId), {
      headers: { Accept: evaluationExportMediaType(format) },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new MonitoringApiError('Der Evaluationsexport konnte nicht geladen werden.');
  }

  if (!response.ok) throw apiError(await readJson(response), response.status);

  return {
    blob: await response.blob(),
    fileName:
      responseFileName(response.headers.get('Content-Disposition')) ??
      `interview-${interviewId}-evaluation.${format === 'markdown' ? 'md' : format}`,
  };
}

export function evaluationExportUrl(
  interviewId: string,
  format: ProfileEvaluationExportFormat,
  profileId?: string,
): string {
  const query = new URLSearchParams({ format });
  if (profileId !== undefined) query.set('profileId', profileId);
  return apiUrl(
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/evaluation/export?${query.toString()}`,
  );
}

export async function getMonitoringSnapshot(
  interviewId: string,
  signal?: AbortSignal,
): Promise<MonitoringSnapshot> {
  const response = await fetchParsed(
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/monitoring`,
    monitoringSnapshotResponseSchema,
    signal,
  );
  return response.snapshot;
}

export async function getMonitoringHistory(
  interviewId: string,
  throughSequence: number,
  signal?: AbortSignal,
): Promise<MonitoringEvent[]> {
  if (throughSequence === 0) return [];

  const events: MonitoringEvent[] = [];
  let afterSequence = 0;

  while (afterSequence < throughSequence) {
    const query = new URLSearchParams({
      afterSequence: String(afterSequence),
      throughSequence: String(throughSequence),
      limit: '500',
    });
    const page = await fetchParsed(
      `/api/v1/interviews/${encodeURIComponent(interviewId)}/event-history?${query.toString()}`,
      monitoringEventHistoryPageSchema,
      signal,
    );
    events.push(...page.events);

    if (!page.hasMore) break;
    if (page.nextAfterSequence === null || page.nextAfterSequence <= afterSequence) {
      throw new MonitoringApiError(
        'Die Event-Historie konnte nicht lückenlos geladen werden.',
        'EVENT_HISTORY_GAP',
      );
    }
    afterSequence = page.nextAfterSequence;
  }

  return events;
}

export function openMonitoringStream(
  interviewId: string,
  afterSequence: number,
  handlers: MonitoringStreamHandlers,
): EventSource {
  const query = new URLSearchParams({ afterSequence: String(afterSequence) });
  const source = new EventSource(
    apiUrl(`/api/v1/interviews/${encodeURIComponent(interviewId)}/events?${query.toString()}`),
  );

  source.addEventListener('ready', (rawEvent) => {
    const data = readEventData(rawEvent);
    if (data === null) return;
    try {
      handlers.onReady(monitoringStreamReadySchema.parse(JSON.parse(data)));
    } catch {
      handlers.onConnectionError();
    }
  });
  source.addEventListener('monitoring', (rawEvent) => {
    const data = readEventData(rawEvent);
    if (data === null) return;
    try {
      handlers.onEvent(monitoringEventSchema.parse(JSON.parse(data)));
    } catch {
      handlers.onConnectionError();
    }
  });
  source.addEventListener('fault', (rawEvent) => {
    const data = readEventData(rawEvent);
    if (data === null) return;
    try {
      handlers.onFault(monitoringStreamFaultSchema.parse(JSON.parse(data)));
    } catch {
      handlers.onConnectionError();
    }
  });
  source.onerror = () => {
    handlers.onConnectionError();
  };

  return source;
}

async function fetchParsed<T>(
  path: string,
  schema: RuntimeSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new MonitoringApiError('Das Backend ist nicht erreichbar.');
  }

  const body = await readJson(response);
  if (!response.ok) throw apiError(body, response.status);

  try {
    return schema.parse(body);
  } catch {
    throw new MonitoringApiError(
      'Das Backend hat eine unerwartete Antwort geliefert.',
      'INVALID_RESPONSE',
      false,
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MonitoringApiError(
      `Das Backend hat keine gültige JSON-Antwort geliefert (${response.status}).`,
      'INVALID_JSON',
      response.status >= 500,
    );
  }
}

function apiError(value: unknown, status: number): MonitoringApiError {
  const parsed = apiErrorEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return new MonitoringApiError(
      `Die Anfrage ist fehlgeschlagen (${status}).`,
      'HTTP_ERROR',
      status >= 500,
    );
  }
  return envelopeError(parsed.data);
}

function envelopeError(envelope: ApiErrorEnvelope): MonitoringApiError {
  return new MonitoringApiError(
    envelope.error.message,
    envelope.error.code,
    envelope.error.retryable,
  );
}

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

function evaluationExportMediaType(format: ProfileEvaluationExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'markdown':
      return 'text/markdown';
    case 'html':
      return 'text/html';
  }
}

function readEventData(event: Event): string | null {
  return event instanceof MessageEvent && typeof event.data === 'string' ? event.data : null;
}

function responseFileName(contentDisposition: string | null): string | null {
  if (contentDisposition === null) return null;
  const match = /filename="?([^";]+)"?/iu.exec(contentDisposition);
  return match?.[1]?.trim() ?? null;
}
