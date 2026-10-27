export interface RealtimeInterviewSecretRequest {
  readonly language?: string;
  readonly instructions: string;
  readonly interviewId: string;
  readonly signal?: AbortSignal;
}

export interface RealtimeInterviewSecret {
  readonly value: string;
  readonly expiresAt: number;
  readonly sessionId: string;
  readonly model: string;
}

export interface VoiceGateway {
  createRealtimeInterviewSecret(
    request: RealtimeInterviewSecretRequest,
  ): Promise<RealtimeInterviewSecret>;
}

export type VoiceProviderOperation = 'configuration' | 'realtime_interview_secret';

export type VoiceProviderErrorCode =
  | 'missing_api_key'
  | 'invalid_request'
  | 'aborted'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response';

export class VoiceProviderError extends Error {
  public readonly provider = 'openai' as const;

  public constructor(
    public readonly code: VoiceProviderErrorCode,
    public readonly operation: VoiceProviderOperation,
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}
