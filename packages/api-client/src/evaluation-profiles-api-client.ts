import {
  API_ERROR_LIMITS,
  EVALUATION_PROFILE_LIMITS,
  EVALUATION_PROFILE_XLSX_FILE_EXTENSION,
  EVALUATION_PROFILE_XLSX_LIMITS,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EVALUATION_PROFILE_XLSX_UPLOAD_FIELD,
  apiErrorEnvelopeSchema,
  idSchema,
  interviewListQuerySchema,
  interviewRenameRequestSchema,
  interviewResponseSchema,
  interviewSummaryPageSchema,
  mvpInterviewSessionSchema,
  evaluationProfileCreateRequestSchema,
  evaluationProfileContentOf,
  evaluationProfileDeleteQuerySchema,
  evaluationProfileDocumentSchema,
  evaluationProfileDuplicateRequestSchema,
  evaluationProfileImportPreviewResponseSchema,
  evaluationProfileImportRequestSchema,
  evaluationProfileListResponseSchema,
  evaluationProfileLockedGuardrailsResponseSchema,
  evaluationProfileResponseSchema,
  evaluationProfileUpdateRequestSchema,
  evaluationProfileXlsxFileNameSchema,
  evaluationProfileXlsxImportPreviewResponseSchema,
  profileEvaluationExportQuerySchema,
  profileEvaluationReportSchema,
  profileEvaluationSelectionQuerySchema,
  profileEvaluationSnapshotResponseSchema,
  profileEvaluationStartRequestSchema,
  type ApiErrorCode,
  type ApiFieldError,
  type EvaluationProfileCreateRequest,
  type EvaluationProfileContent,
  type EvaluationProfileDocument,
  type EvaluationProfileDuplicateRequest,
  type EvaluationProfileImportPreviewResponse,
  type EvaluationProfileImportRequest,
  type EvaluationProfileListResponse,
  type EvaluationProfileLockedGuardrailsResponse,
  type EvaluationProfileResponse,
  type EvaluationProfileUpdateRequest,
  type EvaluationProfileXlsxImportPreviewResponse,
  type InterviewListQuery,
  type InterviewRenameRequest,
  type InterviewSummary,
  type InterviewSummaryPage,
  type MvpInterviewSession,
  type ProfileEvaluationExportFormat,
  type ProfileEvaluationSnapshot,
  type ProfileEvaluationStartRequest,
} from '@orgscience/contracts';

const API_ROOT = '/api/v1/evaluation-profiles';
const JSON_MEDIA_TYPE = 'application/json' as const;
const FINALIZED_INTERVIEW_SESSION_CONCURRENCY = 4;
export const EVALUATION_PROFILE_JSON_IMPORT_MAXIMUM_FILE_BYTES =
  EVALUATION_PROFILE_LIMITS.maximumSerializedBytes + 1024 * 1024;

const EVALUATION_EXPORT_MEDIA_TYPES = Object.freeze({
  json: 'application/json',
  csv: 'text/csv',
  markdown: 'text/markdown',
  html: 'text/html',
} as const satisfies Readonly<Record<ProfileEvaluationExportFormat, string>>);

const EVALUATION_EXPORT_EXTENSIONS = Object.freeze({
  json: '.json',
  csv: '.csv',
  markdown: '.md',
  html: '.html',
} as const satisfies Readonly<Record<ProfileEvaluationExportFormat, string>>);

const PATHS = Object.freeze({
  profiles: API_ROOT,
  profile: (profileId: string) => `${API_ROOT}/${encodeURIComponent(profileId)}`,
  duplicate: (profileId: string) => `${API_ROOT}/${encodeURIComponent(profileId)}/duplicate`,
  export: (profileId: string) => `${API_ROOT}/${encodeURIComponent(profileId)}/export`,
  jsonTemplate: `${API_ROOT}/templates/json`,
  xlsxTemplate: `${API_ROOT}/templates/xlsx`,
  guardrails: `${API_ROOT}/meta/guardrails`,
  jsonImportPreview: `${API_ROOT}/imports/json/preview`,
  jsonImportConfirm: `${API_ROOT}/imports/json/confirm`,
  xlsxImportPreview: `${API_ROOT}/imports/xlsx/preview`,
  interviews: '/api/v1/interviews',
  interview: (interviewId: string) => `/api/v1/interviews/${encodeURIComponent(interviewId)}`,
  interviewSession: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/session`,
  evaluation: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/evaluation`,
  evaluationRetry: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/evaluation/retry`,
  evaluationExport: (interviewId: string) =>
    `/api/v1/interviews/${encodeURIComponent(interviewId)}/evaluation/export`,
});

interface RuntimeSchema<T> {
  readonly safeParse: (value: unknown) =>
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly code: string;
            readonly message: string;
            readonly path: readonly PropertyKey[];
          }[];
        };
      };
}

export type EvaluationProfilesFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface EvaluationProfilesApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: EvaluationProfilesFetch;
}

export type ApiErrorKind = 'network' | 'http' | 'contract';

export class ApiError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly status: number | null;
  public readonly code:
    ApiErrorCode | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'INVALID_REQUEST' | 'NETWORK_ERROR';
  public readonly requestId: string | null;
  public readonly occurredAt: string | null;
  public readonly retryable: boolean;
  public readonly fieldErrors: readonly ApiFieldError[];

  public constructor(input: {
    readonly kind: ApiErrorKind;
    readonly message: string;
    readonly status?: number;
    readonly code?: ApiError['code'];
    readonly requestId?: string;
    readonly occurredAt?: string;
    readonly retryable?: boolean;
    readonly fieldErrors?: readonly ApiFieldError[];
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ApiError';
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code ?? 'INVALID_RESPONSE';
    this.requestId = input.requestId ?? null;
    this.occurredAt = input.occurredAt ?? null;
    this.retryable = input.retryable ?? false;
    this.fieldErrors = input.fieldErrors ?? [];
  }
}

export { ApiError as EvaluationProfilesApiError };

export interface EvaluationProfileJsonArtifact {
  readonly fileName: string;
  readonly mediaType: typeof JSON_MEDIA_TYPE;
  readonly document: EvaluationProfileDocument;
  readonly text: string;
}

export interface EvaluationProfileXlsxArtifact {
  readonly fileName: string;
  readonly mediaType: typeof EVALUATION_PROFILE_XLSX_MEDIA_TYPE;
  readonly bytes: Uint8Array;
}

export type FinalizedInterviewSession = MvpInterviewSession & {
  readonly status: 'completed';
  readonly endedAt: string;
  readonly finalizedAt: string;
};

export interface FinalizedInterview {
  readonly summary: InterviewSummary;
  readonly session: FinalizedInterviewSession;
}

export interface EvaluableInterview {
  readonly summary: InterviewSummary;
  readonly session: MvpInterviewSession;
}

export function isEvaluableInterviewSession(session: MvpInterviewSession): boolean {
  return (
    (session.status === 'active' ||
      session.status === 'paused' ||
      session.status === 'completed') &&
    session.transcript.some(
      (turn) => turn.speaker === 'ai_interviewer' && turn.text.trim().length > 0,
    ) &&
    session.transcript.some((turn) => turn.speaker === 'participant' && turn.text.trim().length > 0)
  );
}

export interface EvaluationExportArtifact {
  readonly format: ProfileEvaluationExportFormat;
  readonly fileName: string;
  readonly mediaType: (typeof EVALUATION_EXPORT_MEDIA_TYPES)[ProfileEvaluationExportFormat];
  readonly text: string;
}

export class EvaluationProfilesApiClient {
  readonly #baseUrl: string;
  readonly #fetch: EvaluationProfilesFetch;

  public constructor(options: EvaluationProfilesApiClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public listProfiles(): Promise<EvaluationProfileListResponse> {
    return this.#requestJson(PATHS.profiles, evaluationProfileListResponseSchema);
  }

  public async renameInterview(
    interviewId: string,
    request: InterviewRenameRequest,
  ): Promise<InterviewSummary> {
    validateInterviewId(interviewId);
    const parsed = parseRequest(
      interviewRenameRequestSchema,
      request,
      'The interview rename request is invalid.',
    );
    const response = await this.#requestJson(
      PATHS.interview(interviewId),
      interviewResponseSchema,
      {
        method: 'PATCH',
        body: JSON.stringify(parsed),
      },
    );
    if (
      response.interview.interviewId !== interviewId ||
      (response.interview.displayName ?? null) !== parsed.displayName
    ) {
      throw contractError(200, 'The renamed interview response has an invalid identity or name.');
    }
    return response.interview;
  }

  public async deleteInterview(interviewId: string): Promise<void> {
    validateInterviewId(interviewId);
    const response = await this.#send(PATHS.interview(interviewId), { method: 'DELETE' });
    if (!response.ok) throw await apiErrorFromResponse(response);
    if (response.status !== 204) {
      throw contractError(response.status, 'Deleting an interview must return HTTP 204.');
    }
  }

  public async getProfile(profileId: string): Promise<EvaluationProfileResponse> {
    validateProfileId(profileId);
    const response = await this.#requestJson(
      PATHS.profile(profileId),
      evaluationProfileResponseSchema,
    );
    return requireProfileIdentity(response, profileId, 'profile response');
  }

  public async createProfile(
    request: EvaluationProfileCreateRequest,
  ): Promise<EvaluationProfileResponse> {
    const parsed = parseRequest(
      evaluationProfileCreateRequestSchema,
      request,
      'The profile create request is invalid.',
    );
    const response = await this.#requestJson(PATHS.profiles, evaluationProfileResponseSchema, {
      method: 'POST',
      body: JSON.stringify(parsed),
    });
    requireNonDefaultProfile(response, 'profile create response');
    requireProfileContent(response, parsed.profile, 'profile create response');
    return response;
  }

  public async updateProfile(
    profileId: string,
    request: EvaluationProfileUpdateRequest,
  ): Promise<EvaluationProfileResponse> {
    validateProfileId(profileId);
    const parsed = parseRequest(
      evaluationProfileUpdateRequestSchema,
      request,
      'The profile update request is invalid.',
    );
    const response = await this.#requestJson(
      PATHS.profile(profileId),
      evaluationProfileResponseSchema,
      {
        method: 'PUT',
        body: JSON.stringify(parsed),
      },
    );
    requireProfileIdentity(response, profileId, 'profile update response');
    requireProfileContent(response, parsed.profile, 'profile update response');
    return response;
  }

  public async duplicateProfile(
    profileId: string,
    request: EvaluationProfileDuplicateRequest,
  ): Promise<EvaluationProfileResponse> {
    validateProfileId(profileId);
    const parsed = parseRequest(
      evaluationProfileDuplicateRequestSchema,
      request,
      'The profile duplicate request is invalid.',
    );
    const response = await this.#requestJson(
      PATHS.duplicate(profileId),
      evaluationProfileResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify(parsed),
      },
    );
    if (response.profile.profileId === profileId || response.profile.name !== parsed.name) {
      throw contractError(200, 'The profile duplicate response has an invalid identity.');
    }
    requireNonDefaultProfile(response, 'profile duplicate response');
    return response;
  }

  public async deleteProfile(profileId: string, expectedUpdatedAt: string): Promise<void> {
    validateProfileId(profileId);
    const query = evaluationProfileDeleteQuerySchema.safeParse({ expectedUpdatedAt });
    if (!query.success) {
      throw requestContractError('The profile delete token is invalid.', query.error.issues);
    }
    const response = await this.#send(
      `${PATHS.profile(profileId)}?${new URLSearchParams(query.data).toString()}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw await apiErrorFromResponse(response);
    if (response.status !== 204) {
      throw contractError(response.status, 'Deleting a profile must return HTTP 204.');
    }
  }

  public async exportProfile(profileId: string): Promise<EvaluationProfileJsonArtifact> {
    validateProfileId(profileId);
    const artifact = await this.#downloadJson(
      PATHS.export(profileId),
      `evaluation-profile-${safeFileSegment(profileId)}.json`,
    );
    if (artifact.document.profile.profileId !== profileId) {
      throw contractError(200, 'The profile export does not match the requested profile.');
    }
    return artifact;
  }

  public getJsonTemplate(): Promise<EvaluationProfileJsonArtifact> {
    return this.#downloadJson(PATHS.jsonTemplate, 'evaluation-profile-template.json');
  }

  public async getXlsxTemplate(): Promise<EvaluationProfileXlsxArtifact> {
    const response = await this.#send(PATHS.xlsxTemplate, {
      headers: { Accept: EVALUATION_PROFILE_XLSX_MEDIA_TYPE },
    });
    if (!response.ok) throw await apiErrorFromResponse(response);
    if (
      mediaTypeEssence(response.headers.get('content-type')) !== EVALUATION_PROFILE_XLSX_MEDIA_TYPE
    ) {
      throw contractError(response.status, 'The XLSX template response has an invalid media type.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes
    ) {
      throw contractError(response.status, 'The XLSX template response has an invalid size.');
    }
    return {
      fileName:
        contentDispositionFileName(
          response.headers.get('content-disposition'),
          EVALUATION_PROFILE_XLSX_FILE_EXTENSION,
        ) ?? 'evaluation-profile-template-v1.xlsx',
      mediaType: EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
      bytes,
    };
  }

  public getLockedGuardrails(): Promise<EvaluationProfileLockedGuardrailsResponse> {
    return this.#requestJson(PATHS.guardrails, evaluationProfileLockedGuardrailsResponseSchema);
  }

  public listInterviews(
    query: Partial<InterviewListQuery> = {},
    signal?: AbortSignal,
  ): Promise<InterviewSummaryPage> {
    const parsed = interviewListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw requestContractError('The interview list query is invalid.', parsed.error.issues);
    }
    const parameters = new URLSearchParams({ limit: String(parsed.data.limit) });
    if (parsed.data.after !== null) parameters.set('after', parsed.data.after);
    return this.#requestJson(
      `${PATHS.interviews}?${parameters.toString()}`,
      interviewSummaryPageSchema,
      signal === undefined ? undefined : { signal },
    );
  }

  public async listAllInterviews(signal?: AbortSignal): Promise<readonly InterviewSummary[]> {
    const interviews: InterviewSummary[] = [];
    const observedCursors = new Set<string>();
    let after: string | null = null;

    do {
      const page = await this.listInterviews({ after, limit: 100 }, signal);
      interviews.push(...page.interviews);
      after = page.nextCursor;
      if (after !== null && observedCursors.has(after)) {
        throw contractError(200, 'The interview list returned a repeated pagination cursor.');
      }
      if (after !== null) observedCursors.add(after);
    } while (after !== null);

    return interviews;
  }

  public async listFinalizedInterviews(
    signal?: AbortSignal,
  ): Promise<readonly FinalizedInterview[]> {
    const completed = (await this.listAllInterviews(signal)).filter(
      (summary) => summary.status === 'completed',
    );
    const finalized: FinalizedInterview[] = [];

    for (
      let index = 0;
      index < completed.length;
      index += FINALIZED_INTERVIEW_SESSION_CONCURRENCY
    ) {
      const batch = completed.slice(index, index + FINALIZED_INTERVIEW_SESSION_CONCURRENCY);
      const candidates = await Promise.all(
        batch.map(async (summary): Promise<FinalizedInterview | null> => {
          try {
            const session = await this.getInterviewSession(summary.interviewId, signal);
            return isFinalizedSession(session) ? { summary, session } : null;
          } catch (error: unknown) {
            if (isMissingInterviewError(error)) return null;
            throw error;
          }
        }),
      );
      finalized.push(
        ...candidates.filter((candidate): candidate is FinalizedInterview => candidate !== null),
      );
    }

    return finalized;
  }

  public async getInterviewSession(
    interviewId: string,
    signal?: AbortSignal,
  ): Promise<MvpInterviewSession> {
    validateInterviewId(interviewId);
    const session = await this.#requestJson(
      PATHS.interviewSession(interviewId),
      mvpInterviewSessionSchema,
      signal === undefined ? undefined : { signal },
    );
    if (session.interviewId !== interviewId) {
      throw contractError(200, 'The interview session response has a mismatched interview ID.');
    }
    return session;
  }

  public async listEvaluableInterviews(
    signal?: AbortSignal,
  ): Promise<readonly EvaluableInterview[]> {
    const summaries = (await this.listAllInterviews(signal)).filter(
      (summary) => summary.status !== 'ready',
    );
    const interviews: EvaluableInterview[] = [];
    for (
      let index = 0;
      index < summaries.length;
      index += FINALIZED_INTERVIEW_SESSION_CONCURRENCY
    ) {
      const batch = summaries.slice(index, index + FINALIZED_INTERVIEW_SESSION_CONCURRENCY);
      const candidates = await Promise.all(
        batch.map(async (summary): Promise<EvaluableInterview | null> => {
          try {
            const session = await this.getInterviewSession(summary.interviewId, signal);
            return isEvaluableInterviewSession(session) ? { summary, session } : null;
          } catch (error: unknown) {
            if (isMissingInterviewError(error)) return null;
            throw error;
          }
        }),
      );
      interviews.push(
        ...candidates.filter((candidate): candidate is EvaluableInterview => candidate !== null),
      );
    }
    return interviews;
  }

  public async getEvaluation(
    interviewId: string,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot> {
    validateInterviewId(interviewId);
    const query = profileEvaluationSelectionQuerySchema.safeParse({ profileId });
    if (!query.success) {
      throw requestContractError('The evaluation selection is invalid.', query.error.issues);
    }
    const suffix = optionalProfileQuery(query.data.profileId);
    const response = await this.#requestJson(
      `${PATHS.evaluation(interviewId)}${suffix}`,
      profileEvaluationSnapshotResponseSchema,
      signal === undefined ? undefined : { signal },
    );
    return validateEvaluationScope(response.evaluation, interviewId, query.data.profileId);
  }

  public startEvaluation(
    interviewId: string,
    request: ProfileEvaluationStartRequest = {},
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot> {
    return this.#executeEvaluation(interviewId, PATHS.evaluation(interviewId), request, signal);
  }

  public retryEvaluation(
    interviewId: string,
    request: ProfileEvaluationStartRequest = {},
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot> {
    return this.#executeEvaluation(
      interviewId,
      PATHS.evaluationRetry(interviewId),
      request,
      signal,
    );
  }

  public async getEvaluationExport(
    interviewId: string,
    format: ProfileEvaluationExportFormat,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<EvaluationExportArtifact> {
    validateInterviewId(interviewId);
    const query = profileEvaluationExportQuerySchema.safeParse({ format, profileId });
    if (!query.success) {
      throw requestContractError('The evaluation export selection is invalid.', query.error.issues);
    }
    const parameters = new URLSearchParams({ format: query.data.format });
    if (query.data.profileId !== undefined) parameters.set('profileId', query.data.profileId);
    const expectedMediaType = EVALUATION_EXPORT_MEDIA_TYPES[query.data.format];
    const extension = EVALUATION_EXPORT_EXTENSIONS[query.data.format];
    const response = await this.#send(
      `${PATHS.evaluationExport(interviewId)}?${parameters.toString()}`,
      {
        headers: { Accept: expectedMediaType },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) throw await apiErrorFromResponse(response);
    if (mediaTypeEssence(response.headers.get('content-type')) !== expectedMediaType) {
      throw contractError(
        response.status,
        'The evaluation export response has an invalid media type.',
      );
    }
    const text = await response.text();
    if (text.length === 0) {
      throw contractError(response.status, 'The evaluation export response is empty.');
    }
    if (query.data.format === 'json') {
      validateJsonEvaluationExport(text, interviewId, query.data.profileId, response.status);
    }
    return {
      format: query.data.format,
      fileName:
        contentDispositionFileName(response.headers.get('content-disposition'), extension) ??
        `interview-${safeFileSegment(interviewId)}-profile-${safeFileSegment(query.data.profileId ?? 'default')}-evaluation${extension}`,
      mediaType: expectedMediaType,
      text,
    };
  }

  public async previewJsonImport(
    document: unknown,
  ): Promise<EvaluationProfileImportPreviewResponse> {
    const response = await this.#requestJson(
      PATHS.jsonImportPreview,
      evaluationProfileImportPreviewResponseSchema,
      {
        method: 'POST',
        body: encodeUnknownJson(document),
      },
    );
    const source = evaluationProfileDocumentSchema.safeParse(document);
    if (
      !source.success ||
      JSON.stringify(source.data.profile) !== JSON.stringify(response.profile)
    ) {
      throw contractError(200, 'The profile import preview does not match the submitted document.');
    }
    return response;
  }

  public async previewXlsxImport(file: File): Promise<EvaluationProfileXlsxImportPreviewResponse> {
    validateXlsxFile(file);
    const formData = new FormData();
    formData.append(EVALUATION_PROFILE_XLSX_UPLOAD_FIELD, file, file.name);
    return this.#requestJson(
      PATHS.xlsxImportPreview,
      evaluationProfileXlsxImportPreviewResponseSchema,
      { method: 'POST', body: formData },
    );
  }

  public async confirmJsonImport(
    request: EvaluationProfileImportRequest,
  ): Promise<EvaluationProfileResponse> {
    const parsed = parseRequest(
      evaluationProfileImportRequestSchema,
      request,
      'The profile import confirmation is invalid.',
    );
    const response = await this.#requestJson(
      PATHS.jsonImportConfirm,
      evaluationProfileResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify(parsed),
      },
    );
    const expectedProfileId =
      parsed.mode === 'create' ? parsed.document.profile.profileId : parsed.targetProfileId;
    requireProfileIdentity(response, expectedProfileId, 'profile import response');
    requireProfileContent(response, parsed.document.profile, 'profile import response');
    if (parsed.mode === 'create') requireNonDefaultProfile(response, 'profile import response');
    return response;
  }

  async #executeEvaluation(
    interviewId: string,
    path: string,
    request: ProfileEvaluationStartRequest,
    signal?: AbortSignal,
  ): Promise<ProfileEvaluationSnapshot> {
    validateInterviewId(interviewId);
    const response = await this.#requestJson(path, profileEvaluationSnapshotResponseSchema, {
      method: 'POST',
      body: encodeRequest(profileEvaluationStartRequestSchema, request),
      ...(signal === undefined ? {} : { signal }),
    });
    return validateEvaluationScope(response.evaluation, interviewId, request.profileId);
  }

  async #downloadJson(
    path: string,
    fallbackFileName: string,
  ): Promise<EvaluationProfileJsonArtifact> {
    const response = await this.#send(path);
    const document = await parseResponse(response, evaluationProfileDocumentSchema);
    return {
      fileName:
        contentDispositionFileName(response.headers.get('content-disposition')) ?? fallbackFileName,
      mediaType: JSON_MEDIA_TYPE,
      document,
      text: serializeEvaluationProfileDocument(document),
    };
  }

  async #requestJson<T>(path: string, schema: RuntimeSchema<T>, init?: RequestInit): Promise<T> {
    const response = await this.#send(path, init);
    return parseResponse(response, schema);
  }

  async #send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', JSON_MEDIA_TYPE);
    if (typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', JSON_MEDIA_TYPE);
    }

    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (init.signal?.aborted === true) throw cause;
      throw new ApiError({
        kind: 'network',
        code: 'NETWORK_ERROR',
        message: 'The evaluation API is not reachable.',
        retryable: true,
        cause,
      });
    }
  }
}

export { EvaluationProfilesApiClient as EvaluationStudioApiClient };

export function serializeEvaluationProfileDocument(document: EvaluationProfileDocument): string {
  const parsed = evaluationProfileDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw requestContractError('The evaluation profile document is invalid.', parsed.error.issues);
  }
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}

function isFinalizedSession(session: MvpInterviewSession): session is FinalizedInterviewSession {
  return session.status === 'completed' && session.endedAt !== null && session.finalizedAt !== null;
}

function isMissingInterviewError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 404;
}

function optionalProfileQuery(profileId: string | undefined): string {
  return profileId === undefined ? '' : `?${new URLSearchParams({ profileId }).toString()}`;
}

function validateProfileId(profileId: string): void {
  const parsed = idSchema.safeParse(profileId);
  if (!parsed.success) {
    throw requestContractError(
      'The profile ID is invalid.',
      parsed.error.issues.map((issue) => ({ ...issue, path: ['profileId', ...issue.path] })),
    );
  }
}

function validateInterviewId(interviewId: string): void {
  const parsed = idSchema.safeParse(interviewId);
  if (!parsed.success) {
    throw requestContractError(
      'The interview ID is invalid.',
      parsed.error.issues.map((issue) => ({ ...issue, path: ['interviewId', ...issue.path] })),
    );
  }
}

function validateEvaluationScope(
  evaluation: ProfileEvaluationSnapshot,
  interviewId: string,
  profileId: string | undefined,
): ProfileEvaluationSnapshot {
  if (
    evaluation.interviewId !== interviewId ||
    (profileId !== undefined && evaluation.profileId !== profileId)
  ) {
    throw contractError(200, 'The evaluation response does not match the requested scope.');
  }
  return evaluation;
}

function requireProfileIdentity(
  response: EvaluationProfileResponse,
  expectedProfileId: string,
  operation: string,
): EvaluationProfileResponse {
  if (response.profile.profileId !== expectedProfileId) {
    throw contractError(200, `The ${operation} does not match the requested profile.`);
  }
  return response;
}

function requireNonDefaultProfile(response: EvaluationProfileResponse, operation: string): void {
  if (response.profile.isDefault) {
    throw contractError(200, `The ${operation} unexpectedly returned a default profile.`);
  }
}

function requireProfileContent(
  response: EvaluationProfileResponse,
  expected: EvaluationProfileContent | EvaluationProfileDocument['profile'],
  operation: string,
): void {
  if (
    JSON.stringify(profileContent(response.profile)) !== JSON.stringify(profileContent(expected))
  ) {
    throw contractError(200, `The ${operation} does not match the submitted profile content.`);
  }
}

function profileContent(profile: {
  readonly name: string;
  readonly description: string;
  readonly coderPrompt: string;
  readonly scale: EvaluationProfileContent['scale'];
  readonly dimensions: EvaluationProfileContent['dimensions'];
  readonly items: EvaluationProfileContent['items'];
  readonly calculation?: EvaluationProfileContent['calculation'];
}): EvaluationProfileContent {
  return evaluationProfileContentOf(profile);
}

function validateJsonEvaluationExport(
  text: string,
  interviewId: string,
  profileId: string | undefined,
  status: number,
): void {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw contractError(status, 'The JSON evaluation export is not valid JSON.');
  }
  const parsed = profileEvaluationReportSchema.safeParse(payload);
  if (!parsed.success) {
    throw contractError(status, 'The JSON evaluation export does not match the report contract.');
  }
  if (
    parsed.data.interviewId !== interviewId ||
    (profileId !== undefined && parsed.data.profileId !== profileId)
  ) {
    throw contractError(status, 'The JSON evaluation export does not match the requested scope.');
  }
}

function parseRequest<T>(schema: RuntimeSchema<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw requestContractError(message, parsed.error.issues);
  return parsed.data;
}

function encodeRequest<T>(schema: RuntimeSchema<T>, value: T): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw requestContractError(
      'The request does not match the evaluation profile contract.',
      parsed.error.issues,
    );
  }
  return JSON.stringify(parsed.data);
}

function encodeUnknownJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
  } catch (cause) {
    throw new ApiError({
      kind: 'contract',
      code: 'INVALID_REQUEST',
      message: 'The import preview is not valid JSON data.',
      cause,
    });
  }
  throw new ApiError({
    kind: 'contract',
    code: 'INVALID_REQUEST',
    message: 'The import preview is not valid JSON data.',
  });
}

async function parseResponse<T>(response: Response, schema: RuntimeSchema<T>): Promise<T> {
  const payload = await readJson(response);
  if (!response.ok) throw apiErrorFromPayload(response, payload);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw contractError(
      response.status,
      'The server response does not match the expected contract.',
    );
  }
  return parsed.data;
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  return apiErrorFromPayload(response, await readJson(response));
}

function apiErrorFromPayload(response: Response, payload: unknown): ApiError {
  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError({
      kind: 'http',
      status: response.status,
      code: 'HTTP_ERROR',
      message: `The request failed with HTTP ${String(response.status)}.`,
      retryable: response.status >= 500,
    });
  }

  return new ApiError({
    kind: 'http',
    status: response.status,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    requestId: parsed.data.error.requestId,
    occurredAt: parsed.data.error.occurredAt,
    retryable: parsed.data.error.retryable,
    fieldErrors: parsed.data.error.fieldErrors,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function contractError(status: number, message: string): ApiError {
  return new ApiError({
    kind: 'contract',
    status,
    code: 'INVALID_RESPONSE',
    message,
  });
}

function requestContractError(
  message: string,
  issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly path: readonly PropertyKey[];
  }[],
): ApiError {
  return new ApiError({
    kind: 'contract',
    code: 'INVALID_REQUEST',
    message,
    fieldErrors: issues.slice(0, API_ERROR_LIMITS.maximumFieldErrors).map((issue) => ({
      path: issue.path
        .slice(0, API_ERROR_LIMITS.maximumPathSegments)
        .map((part) =>
          typeof part === 'number'
            ? part
            : String(part).slice(0, API_ERROR_LIMITS.maximumPathSegmentCharacters),
        ),
      code: issue.code.slice(0, API_ERROR_LIMITS.maximumCodeCharacters),
      message: issue.message.slice(0, API_ERROR_LIMITS.maximumFieldMessageCharacters),
    })),
  });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.replace(/\/+$/, '');
}

function contentDispositionFileName(
  value: string | null,
  extension: string = '.json',
): string | null {
  if (value === null) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
  if (encoded !== undefined) {
    try {
      return safeDownloadFileName(decodeURIComponent(encoded), extension);
    } catch {
      return null;
    }
  }
  const plain = /filename="([^"]+)"/iu.exec(value)?.[1] ?? /filename=([^;\s]+)/iu.exec(value)?.[1];
  return plain === undefined ? null : safeDownloadFileName(plain, extension);
}

function safeDownloadFileName(value: string, extension: string): string | null {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (leaf === '' || !leaf.toLowerCase().endsWith(extension)) return null;
  const safe = leaf.replace(/[^a-zA-Z0-9._-]/gu, '-');
  return safe.length > 0 ? safe : null;
}

function validateXlsxFile(file: File): void {
  const fileName = file.name.trim();
  if (!evaluationProfileXlsxFileNameSchema.safeParse(fileName).success) {
    throw new ApiError({
      kind: 'contract',
      code: 'INVALID_REQUEST',
      message: 'The XLSX file name is invalid.',
      fieldErrors: [
        {
          path: ['file', 'name'],
          code: 'invalid_file_name',
          message: 'Use a plain file name ending in .xlsx.',
        },
      ],
    });
  }
  if (file.size === 0 || file.size > EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes) {
    throw new ApiError({
      kind: 'contract',
      code: 'INVALID_REQUEST',
      message: 'The XLSX file size is invalid.',
      fieldErrors: [
        {
          path: ['file', 'size'],
          code: file.size === 0 ? 'empty_file' : 'file_too_large',
          message: `The XLSX file must contain between 1 and ${String(EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes)} bytes.`,
        },
      ],
    });
  }
}

function mediaTypeEssence(value: string | null): string | null {
  if (value === null) return null;
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

function safeFileSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/gu, '-');
  return safe.length > 0 ? safe : 'profile';
}
