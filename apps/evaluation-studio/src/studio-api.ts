import {
  ApiError,
  EVALUATION_PROFILE_JSON_IMPORT_MAXIMUM_FILE_BYTES,
  EvaluationProfilesApiClient,
  type EvaluationExportArtifact,
  type EvaluationProfileJsonArtifact,
  type EvaluationProfilesApiClientOptions,
  type EvaluableInterview,
} from '@orgscience/api-client';
import type {
  ApiFieldError,
  EvaluationProfile,
  EvaluationProfileContent,
  EvaluationProfileDocument,
  EvaluationProfileImportPreviewResponse,
  EvaluationProfileListResponse,
  EvaluationProfileLockedGuardrailsResponse,
  EvaluationProfileResponse,
  EvaluationProfileXlsxImportPreviewResponse,
  InterviewRenameRequest,
  InterviewSummary,
  ProfileEvaluationExportFormat,
  ProfileEvaluationSnapshot,
} from '@orgscience/contracts';
import { EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION } from '@orgscience/contracts';

export interface EvaluationStudioApi {
  listProfiles(): Promise<EvaluationProfileListResponse>;
  getProfile(profileId: string): Promise<EvaluationProfileResponse>;
  createProfile(request: {
    readonly profile: EvaluationProfileContent;
  }): Promise<EvaluationProfileResponse>;
  updateProfile(
    profileId: string,
    request: {
      readonly profile: EvaluationProfileContent;
      readonly expectedUpdatedAt: string;
    },
  ): Promise<EvaluationProfileResponse>;
  duplicateProfile(
    profileId: string,
    request: { readonly name: string },
  ): Promise<EvaluationProfileResponse>;
  deleteProfile(profileId: string, expectedUpdatedAt: string): Promise<void>;
  exportProfile(profileId: string): Promise<EvaluationProfileJsonArtifact>;
  getJsonTemplate(): Promise<EvaluationProfileJsonArtifact>;
  getXlsxTemplate(): Promise<{
    readonly fileName: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }>;
  getLockedGuardrails(): Promise<EvaluationProfileLockedGuardrailsResponse>;
  previewJsonImport(document: unknown): Promise<EvaluationProfileImportPreviewResponse>;
  previewXlsxImport(file: File): Promise<EvaluationProfileXlsxImportPreviewResponse>;
  confirmJsonImport(
    request:
      | { readonly mode: 'create'; readonly document: EvaluationProfileDocument }
      | {
          readonly mode: 'replace';
          readonly targetProfileId: string;
          readonly expectedUpdatedAt: string;
          readonly document: EvaluationProfileDocument;
        },
  ): Promise<EvaluationProfileResponse>;
  listEvaluableInterviews(signal?: AbortSignal): Promise<readonly EvaluableInterview[]>;
  renameInterview(interviewId: string, request: InterviewRenameRequest): Promise<InterviewSummary>;
  deleteInterview(interviewId: string): Promise<void>;
  getEvaluation(
    interviewId: string,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot>;
  startEvaluation(
    interviewId: string,
    request?: { readonly profileId?: string },
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot>;
  retryEvaluation(
    interviewId: string,
    request?: { readonly profileId?: string },
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot>;
  getEvaluationExport(
    interviewId: string,
    format: ProfileEvaluationExportFormat,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<EvaluationExportArtifact>;
}

export interface StudioOperationError {
  readonly message: string;
  readonly conflict: boolean;
  readonly retryable: boolean;
  readonly fieldErrors: readonly ApiFieldError[];
  readonly requestId: string | null;
}

export interface PersistedProfileTarget {
  readonly profileId: string;
  readonly updatedAt: string;
}

export interface ImportReplaceTarget extends PersistedProfileTarget {
  readonly name: string;
}

export type ImportPreview =
  | {
      readonly kind: 'json';
      readonly fileName: string;
      readonly document: EvaluationProfileDocument;
    }
  | {
      readonly kind: 'xlsx';
      readonly fileName: string;
      readonly document: EvaluationProfileDocument;
      readonly source: EvaluationProfileXlsxImportPreviewResponse['source'];
    };

export function createStudioApi(
  options: EvaluationProfilesApiClientOptions = {},
): EvaluationStudioApi {
  return new EvaluationProfilesApiClient(options);
}

export const studioApi = createStudioApi({
  baseUrl: (import.meta.env['VITE_API_BASE_URL'] ?? '').trim(),
});

export async function saveProfile(
  api: EvaluationStudioApi,
  content: EvaluationProfileContent,
  target: PersistedProfileTarget | null,
): Promise<EvaluationProfile> {
  const response =
    target === null
      ? await api.createProfile({ profile: content })
      : await api.updateProfile(target.profileId, {
          profile: content,
          expectedUpdatedAt: target.updatedAt,
        });
  return response.profile;
}

export function captureImportReplaceTarget(
  profile: EvaluationProfile | null,
): ImportReplaceTarget | null {
  if (profile === null) return null;
  return Object.freeze({
    profileId: profile.profileId,
    name: profile.name,
    updatedAt: profile.updatedAt,
  });
}

export async function confirmImport(
  api: EvaluationStudioApi,
  preview: ImportPreview,
  target: PersistedProfileTarget | null,
): Promise<EvaluationProfile> {
  const response =
    target === null
      ? await api.confirmJsonImport({ mode: 'create', document: preview.document })
      : await api.confirmJsonImport({
          mode: 'replace',
          targetProfileId: target.profileId,
          expectedUpdatedAt: target.updatedAt,
          document: preview.document,
        });
  return response.profile;
}

export async function previewJsonFile(
  api: EvaluationStudioApi,
  file: File,
): Promise<ImportPreview> {
  if (file.size > EVALUATION_PROFILE_JSON_IMPORT_MAXIMUM_FILE_BYTES) {
    throw new StudioFileError('Die JSON-Datei überschreitet die maximale Größe von 20 MiB.', [
      {
        path: ['file', 'size'],
        code: 'file_too_large',
        message: 'Die JSON-Datei darf höchstens 20 MiB groß sein.',
      },
    ]);
  }
  let document: unknown;
  try {
    document = JSON.parse(await file.text()) as unknown;
  } catch (cause) {
    throw new StudioFileError(
      'Die Datei enthält kein gültiges JSON.',
      [{ path: ['file'], code: 'invalid_json', message: 'JSON-Syntax prüfen.' }],
      cause,
    );
  }
  const response = await api.previewJsonImport(document);
  return {
    kind: 'json',
    fileName: file.name,
    document: {
      schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
      profile: response.profile,
    },
  };
}

export async function previewXlsxFile(
  api: EvaluationStudioApi,
  file: File,
): Promise<ImportPreview> {
  const response = await api.previewXlsxImport(file);
  return {
    kind: 'xlsx',
    fileName: file.name,
    document: response.document,
    source: response.source,
  };
}

export function downloadJsonArtifact(artifact: EvaluationProfileJsonArtifact): void {
  downloadBlob(new Blob([artifact.text], { type: artifact.mediaType }), artifact.fileName);
}

export function downloadXlsxArtifact(artifact: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
}): void {
  const bytes = new Uint8Array(artifact.bytes.byteLength);
  bytes.set(artifact.bytes);
  downloadBlob(new Blob([bytes.buffer], { type: artifact.mediaType }), artifact.fileName);
}

export function downloadEvaluationArtifact(artifact: EvaluationExportArtifact): void {
  downloadBlob(new Blob([artifact.text], { type: artifact.mediaType }), artifact.fileName);
}

const TRANSCRIPT_EXPORT_COPY = {
  de: {
    interviewId: 'Interview-ID',
    language: 'Sprache',
    languageName: 'Deutsch',
    startedAt: 'Beginn',
    endedAt: 'Ende',
    notEnded: 'Noch nicht beendet',
    notStarted: 'Nicht dokumentiert',
    status: 'Interviewstatus',
    snapshot:
      'Bisheriges Transkript; nur gespeicherte finale Äußerungen. Fehlende Antworten werden nicht ergänzt.',
    interviewer: 'AI-Interviewer',
    participant: 'Interviewpartner',
    interrupted: 'unterbrochen',
    technicalGap: 'Technische Lücke',
  },
  en: {
    interviewId: 'Interview ID',
    language: 'Language',
    languageName: 'English',
    startedAt: 'Started',
    endedAt: 'Ended',
    notEnded: 'Not ended yet',
    notStarted: 'Not recorded',
    status: 'Interview status',
    snapshot: 'Transcript so far; saved final utterances only. Missing answers are not invented.',
    interviewer: 'AI interviewer',
    participant: 'Participant',
    interrupted: 'interrupted',
    technicalGap: 'Technical gap',
  },
} as const;

export function createInterviewTranscriptMarkdown(interview: EvaluableInterview): string {
  const { session } = interview;
  const copy = TRANSCRIPT_EXPORT_COPY[session.language];
  const startedAt = session.startedAt ?? session.transcript.at(0)?.occurredAt ?? null;
  const entries = [
    ...session.transcript.map((turn) => ({ kind: 'turn' as const, value: turn })),
    ...session.technicalGaps.map((gap) => ({ kind: 'gap' as const, value: gap })),
  ].sort((left, right) => left.value.sequenceNumber - right.value.sequenceNumber);
  const lines = [
    `# ${interviewDisplayName(interview)}`,
    '',
    `${copy.interviewId}: ${session.interviewId}`,
    `${session.language === 'en' ? 'Guide' : 'Leitfaden'}: ${session.guideTitle}`,
    `${copy.language}: ${copy.languageName}`,
    `${copy.startedAt}: ${startedAt === null ? copy.notStarted : formatTranscriptTimestamp(startedAt, session.language)}`,
    `${copy.endedAt}: ${session.endedAt === null ? copy.notEnded : formatTranscriptTimestamp(session.endedAt, session.language)}`,
    `${copy.status}: ${interview.summary.status}`,
    ...(session.finalizedAt === null ? ['', `> ${copy.snapshot}`] : []),
    '',
  ];

  for (const entry of entries) {
    if (entry.kind === 'turn') {
      const speaker =
        entry.value.speaker === 'ai_interviewer' ? copy.interviewer : copy.participant;
      const interruption = entry.value.interrupted ? ` · ${copy.interrupted}` : '';
      lines.push(
        `## ${formatTranscriptTimestamp(entry.value.occurredAt, session.language)} · ${speaker}${interruption}`,
        '',
        entry.value.text,
        '',
      );
      continue;
    }

    lines.push(
      `## ${formatTranscriptTimestamp(entry.value.occurredAt, session.language)} · ${copy.technicalGap}`,
      '',
      entry.value.description,
      '',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function interviewDisplayName(interview: EvaluableInterview): string {
  return interview.summary.displayName ?? interview.session.guideTitle;
}

export function downloadInterviewTranscriptMarkdown(interview: EvaluableInterview): void {
  downloadBlob(
    new Blob([createInterviewTranscriptMarkdown(interview)], {
      type: 'text/markdown;charset=utf-8',
    }),
    `interview-${interview.summary.interviewId}.md`,
  );
}

export function operationError(reason: unknown, fallback: string): StudioOperationError {
  if (reason instanceof ApiError) {
    return {
      message: reason.message,
      conflict: reason.status === 409 || reason.code === 'CONFLICT',
      retryable: reason.retryable,
      fieldErrors: reason.fieldErrors,
      requestId: reason.requestId,
    };
  }
  if (reason instanceof StudioFileError) {
    return {
      message: reason.message,
      conflict: false,
      retryable: false,
      fieldErrors: reason.fieldErrors,
      requestId: null,
    };
  }
  return {
    message: reason instanceof Error ? reason.message : fallback,
    conflict: false,
    retryable: true,
    fieldErrors: [],
    requestId: null,
  };
}

export function formatFieldPath(path: ApiFieldError['path']): string {
  const cell = xlsxCellLocation(path);
  if (cell !== null) {
    return [
      ...formatPathSegments(path.slice(0, cell.start)),
      cell.label,
      ...formatPathSegments(path.slice(cell.end)),
    ].join(' / ');
  }
  return formatPathSegments(path).join(' / ');
}

function xlsxCellLocation(
  path: ApiFieldError['path'],
): { readonly start: number; readonly end: number; readonly label: string } | null {
  for (let index = 0; index <= path.length - 6; index += 1) {
    const sheet = path[index + 1];
    const row = path[index + 3];
    const column = path[index + 5];
    if (
      path[index] === 'sheets' &&
      typeof sheet === 'string' &&
      path[index + 2] === 'rows' &&
      typeof row === 'number' &&
      path[index + 4] === 'columns' &&
      typeof column === 'string'
    ) {
      return { start: index, end: index + 6, label: `${sheet}!${column}${String(row)}` };
    }
  }
  return null;
}

function formatPathSegments(path: ApiFieldError['path']): string[] {
  return path.map((segment, index) => {
    if (typeof segment !== 'number') return segment;
    return path[index - 1] === 'rows'
      ? `Zeile ${String(segment)}`
      : `Eintrag ${String(segment + 1)}`;
  });
}

class StudioFileError extends Error {
  public constructor(
    message: string,
    readonly fieldErrors: readonly ApiFieldError[],
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'StudioFileError';
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatTranscriptTimestamp(
  timestamp: string,
  language: EvaluableInterview['session']['language'],
): string {
  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
