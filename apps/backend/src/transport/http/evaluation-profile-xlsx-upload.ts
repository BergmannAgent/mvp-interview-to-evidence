import {
  EVALUATION_PROFILE_XLSX_LIMITS,
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
  EVALUATION_PROFILE_XLSX_UPLOAD_FIELD,
  evaluationProfileXlsxFileNameSchema,
  type ApiFieldError,
} from '@orgscience/contracts';

import type { EvaluationProfileXlsxUpload } from '../../application/evaluation-profiles/index.js';
import { mediaTypeEssence } from './media-type.js';

export const MAXIMUM_EVALUATION_PROFILE_XLSX_REQUEST_BYTES =
  EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes + 1024 * 1024;

const ALLOWED_FILE_MEDIA_TYPES = new Set([
  '',
  'application/octet-stream',
  EVALUATION_PROFILE_XLSX_MEDIA_TYPE,
]);

export type EvaluationProfileXlsxUploadResult =
  | { readonly ok: true; readonly value: EvaluationProfileXlsxUpload }
  | {
      readonly ok: false;
      readonly status: 400 | 413 | 415;
      readonly message: string;
      readonly fieldErrors: readonly ApiFieldError[];
    };

export async function readEvaluationProfileXlsxUpload(
  request: Request,
): Promise<EvaluationProfileXlsxUploadResult> {
  if (mediaTypeEssence(request.headers.get('content-type')) !== 'multipart/form-data') {
    return invalidUpload(415, 'The XLSX import must use multipart/form-data.', {
      path: ['body'],
      code: 'invalid_content_type',
      message: 'Content-Type must be multipart/form-data.',
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return invalidUpload(400, 'The multipart XLSX upload could not be read.', {
      path: ['body'],
      code: 'invalid_multipart_body',
      message: 'The multipart request body is malformed.',
    });
  }

  const fileEntries = formData.getAll(EVALUATION_PROFILE_XLSX_UPLOAD_FIELD);
  const allEntries = [...formData.entries()];
  const uploadedFiles = allEntries.filter(([, value]) => typeof value !== 'string');
  if (fileEntries.length === 0) {
    return invalidUpload(400, 'The XLSX upload is missing.', {
      path: ['file'],
      code: 'missing_file',
      message: `Upload one XLSX file using multipart field "${EVALUATION_PROFILE_XLSX_UPLOAD_FIELD}".`,
    });
  }
  if (
    fileEntries.length !== 1 ||
    uploadedFiles.length !== 1 ||
    allEntries.length !== 1 ||
    allEntries[0]?.[0] !== EVALUATION_PROFILE_XLSX_UPLOAD_FIELD
  ) {
    return invalidUpload(400, 'The multipart body must contain exactly one XLSX file.', {
      path: ['file'],
      code: 'invalid_file_count',
      message: `Provide exactly one file part named "${EVALUATION_PROFILE_XLSX_UPLOAD_FIELD}" and no other fields.`,
    });
  }

  const file = fileEntries[0];
  if (file === undefined || typeof file === 'string') {
    return invalidUpload(400, 'The XLSX upload is missing.', {
      path: ['file'],
      code: 'missing_file',
      message: `Upload one XLSX file using multipart field "${EVALUATION_PROFILE_XLSX_UPLOAD_FIELD}".`,
    });
  }

  const fileName = file.name.trim();
  if (!evaluationProfileXlsxFileNameSchema.safeParse(fileName).success) {
    return invalidUpload(415, 'The upload must be a plain .xlsx file.', {
      path: ['file', 'name'],
      code: 'invalid_file_name',
      message: 'File name must be a plain name ending in .xlsx; .xls and .xlsm are not supported.',
    });
  }

  const mediaType = file.type.trim().toLowerCase();
  if (!ALLOWED_FILE_MEDIA_TYPES.has(mediaType)) {
    return invalidUpload(415, 'The uploaded file type is not supported.', {
      path: ['file', 'type'],
      code: 'invalid_file_type',
      message: `Use ${EVALUATION_PROFILE_XLSX_MEDIA_TYPE} or application/octet-stream.`,
    });
  }
  if (file.size === 0) {
    return invalidUpload(400, 'The uploaded XLSX file is empty.', {
      path: ['file'],
      code: 'empty_file',
      message: 'The XLSX file must not be empty.',
    });
  }
  if (file.size > EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes) {
    return invalidUpload(413, 'The uploaded XLSX file is too large.', {
      path: ['file', 'size'],
      code: 'file_too_large',
      message: `The XLSX file may contain at most ${String(EVALUATION_PROFILE_XLSX_LIMITS.maximumFileBytes)} bytes.`,
    });
  }

  try {
    return {
      ok: true,
      value: {
        fileName,
        mediaType,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
    };
  } catch {
    return invalidUpload(400, 'The uploaded XLSX file could not be read.', {
      path: ['file'],
      code: 'file_read_failed',
      message: 'The XLSX file bytes could not be read.',
    });
  }
}

function invalidUpload(
  status: 400 | 413 | 415,
  message: string,
  fieldError: ApiFieldError,
): EvaluationProfileXlsxUploadResult {
  return { ok: false, status, message, fieldErrors: [fieldError] };
}
