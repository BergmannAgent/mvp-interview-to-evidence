import type {
  ApiFieldError,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EvaluationProfileXlsxImportPreviewResponse,
} from '@orgscience/contracts';

export interface EvaluationProfileXlsxUpload {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface EvaluationProfileXlsxArtifact {
  readonly body: Uint8Array;
  readonly contentType: typeof EVALUATION_PROFILE_XLSX_MEDIA_TYPE;
  readonly fileName: string;
}

export interface EvaluationProfileXlsxWorkbook {
  createTemplate(): Promise<EvaluationProfileXlsxArtifact>;
  previewImport(
    upload: EvaluationProfileXlsxUpload,
  ): Promise<EvaluationProfileXlsxImportPreviewResponse>;
}

export class EvaluationProfileXlsxWorkbookError extends Error {
  public constructor(
    message: string,
    readonly fieldErrors: readonly ApiFieldError[],
  ) {
    super(message);
    this.name = 'EvaluationProfileXlsxWorkbookError';
  }
}
