import { supportedLocaleSchema, type SupportedLocale } from '@orgscience/contracts';

import { mediaTypeEssence } from './media-type.js';

export const MAXIMUM_GUIDE_FILE_BYTES = 1_000_000;
export const MAXIMUM_GUIDE_REQUEST_BYTES = 1_100_000;

export type GuideUploadError =
  | { readonly code: 'invalid_content_type' }
  | { readonly code: 'invalid_multipart_body' }
  | { readonly code: 'missing_file' }
  | { readonly code: 'multiple_files' }
  | { readonly code: 'invalid_file_name' }
  | { readonly code: 'invalid_file_type' }
  | { readonly code: 'invalid_source_language' }
  | { readonly code: 'file_too_large' }
  | { readonly code: 'invalid_text_encoding' };

export type GuideUploadResult =
  | { readonly ok: true; readonly markdown: string; readonly sourceLanguage: SupportedLocale }
  | { readonly ok: false; readonly error: GuideUploadError };

const ALLOWED_MEDIA_TYPES = new Set([
  '',
  'application/octet-stream',
  'text/markdown',
  'text/plain',
]);

export async function readGuideUpload(request: Request): Promise<GuideUploadResult> {
  const contentType = mediaTypeEssence(request.headers.get('content-type'));
  if (contentType !== 'multipart/form-data') {
    return { ok: false, error: { code: 'invalid_content_type' } };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, error: { code: 'invalid_multipart_body' } };
  }

  const entries = formData.getAll('file');
  const uploadedFileCount = [...formData.values()].filter(
    (value) => typeof value !== 'string',
  ).length;
  if (entries.length === 0) {
    return { ok: false, error: { code: 'missing_file' } };
  }
  if (entries.length !== 1 || uploadedFileCount !== 1) {
    return { ok: false, error: { code: 'multiple_files' } };
  }

  const sourceLanguage = supportedLocaleSchema.safeParse(formData.get('sourceLanguage') ?? 'de');
  if (!sourceLanguage.success) {
    return { ok: false, error: { code: 'invalid_source_language' } };
  }

  const file = entries[0];
  if (file === undefined || typeof file === 'string') {
    return { ok: false, error: { code: 'missing_file' } };
  }
  if (!file.name.toLowerCase().endsWith('.md')) {
    return { ok: false, error: { code: 'invalid_file_name' } };
  }
  if (!ALLOWED_MEDIA_TYPES.has(file.type.toLowerCase())) {
    return { ok: false, error: { code: 'invalid_file_type' } };
  }
  if (file.size > MAXIMUM_GUIDE_FILE_BYTES) {
    return { ok: false, error: { code: 'file_too_large' } };
  }

  try {
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    return { ok: true, markdown, sourceLanguage: sourceLanguage.data };
  } catch {
    return { ok: false, error: { code: 'invalid_text_encoding' } };
  }
}
