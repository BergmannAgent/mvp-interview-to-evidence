import {
  ApiError,
  EVALUATION_PROFILE_JSON_IMPORT_MAXIMUM_FILE_BYTES,
} from '@orgscience/api-client';
import {
  evaluationProfileSchema,
  mvpInterviewSessionSchema,
  type EvaluationProfile,
  type EvaluationProfileContent,
  type EvaluationProfileDocument,
} from '@orgscience/contracts';
import { describe, expect, it, vi } from 'vitest';

import { starterProfileContent } from './profile-draft.js';
import {
  captureImportReplaceTarget,
  confirmImport,
  createInterviewTranscriptMarkdown,
  formatFieldPath,
  operationError,
  previewJsonFile,
  saveProfile,
  type EvaluationStudioApi,
  type ImportPreview,
} from './studio-api.js';

describe('evaluation studio API orchestration', () => {
  it('exports the custom interview name while keeping the original guide and exact transcript quotes', () => {
    const session = mvpInterviewSessionSchema.parse({
      interviewId: 'named-interview',
      guideId: 'guide',
      guideTitle: 'Original guide',
      language: 'en',
      status: 'paused',
      startedAt: '2026-10-01T10:00:00.000Z',
      endedAt: null,
      finalizedAt: null,
      updatedAt: '2026-10-01T10:03:00.000Z',
      currentQuestionIndex: 0,
      totalQuestions: 1,
      currentQuestion: null,
      partialTranscript: 'DO NOT EXPORT',
      transcript: [
        {
          turnId: 'participant',
          interviewId: 'named-interview',
          sequenceNumber: 1,
          speaker: 'participant',
          turnType: 'participant_answer',
          text: 'Originalzitat: "Das bleibt unverändert."',
          occurredAt: '2026-10-01T10:02:00.000Z',
          guideReference: null,
          interrupted: false,
        },
      ],
    });
    const original = JSON.stringify(session);
    const markdown = createInterviewTranscriptMarkdown({
      summary: {
        interviewId: session.interviewId,
        guideId: session.guideId,
        guideTitle: session.guideTitle,
        displayName: 'Interview Anna',
        language: 'en',
        status: 'paused',
        currentMainQuestionId: null,
        activeWorkflowRunId: null,
        createdAt: session.startedAt ?? session.updatedAt,
        updatedAt: session.updatedAt,
        startedAt: session.startedAt,
      },
      session,
    });
    expect(markdown).toMatch(/^# Interview Anna\n/u);
    expect(markdown).toContain('Guide: Original guide');
    expect(markdown).toContain(session.transcript[0]?.text);
    expect(markdown).not.toContain('DO NOT EXPORT');
    expect(JSON.stringify(session)).toBe(original);
  });

  it('exports the complete canonical interview transcript as localized Markdown', () => {
    const markdown = createInterviewTranscriptMarkdown({
      summary: {
        interviewId: 'interview-export',
        guideId: 'guide-export',
        language: 'de',
        guideTitle: 'Exportleitfaden',
        status: 'completed',
        currentMainQuestionId: null,
        activeWorkflowRunId: null,
        createdAt: '2026-09-10T09:00:00.000Z',
        updatedAt: '2026-09-10T09:05:00.000Z',
        startedAt: '2026-09-10T09:01:00.000Z',
      },
      session: {
        interviewId: 'interview-export',
        guideId: 'guide-export',
        language: 'de',
        guideTitle: 'Exportleitfaden',
        status: 'completed',
        stateVersion: 1,
        currentQuestionIndex: 1,
        totalQuestions: 1,
        currentQuestion: null,
        startedAt: '2026-09-10T09:01:00.000Z',
        endedAt: '2026-09-10T09:05:00.000Z',
        updatedAt: '2026-09-10T09:05:01.000Z',
        partialTranscript: null,
        transcript: [
          {
            turnId: 'turn-question',
            interviewId: 'interview-export',
            sequenceNumber: 1,
            speaker: 'ai_interviewer',
            turnType: 'main_question',
            text: 'Wie reagiert Ihre Organisation?',
            occurredAt: '2026-09-10T09:01:10.000Z',
            guideReference: null,
            interrupted: false,
          },
          {
            turnId: 'turn-answer',
            interviewId: 'interview-export',
            sequenceNumber: 3,
            speaker: 'participant',
            turnType: 'participant_answer',
            text: 'Der Originaltext bleibt unverändert: ä, ö, ü.',
            occurredAt: '2026-09-10T09:02:00.000Z',
            guideReference: null,
            interrupted: false,
          },
        ],
        technicalGaps: [
          {
            gapId: 'gap-export',
            interviewId: 'interview-export',
            sequenceNumber: 2,
            source: 'transport',
            description: 'Kurze technische Unterbrechung.',
            occurredAt: '2026-09-10T09:01:30.000Z',
          },
        ],
        finalizedAt: '2026-09-10T09:05:01.000Z',
      },
    });

    expect(markdown).toContain('# Exportleitfaden');
    expect(markdown).toContain('Interview-ID: interview-export');
    expect(markdown).toContain('AI-Interviewer');
    expect(markdown).toContain('Interviewpartner');
    expect(markdown).toContain('Der Originaltext bleibt unverändert: ä, ö, ü.');
    expect(markdown.indexOf('Wie reagiert Ihre Organisation?')).toBeLessThan(
      markdown.indexOf('Kurze technische Unterbrechung.'),
    );
    expect(markdown.indexOf('Kurze technische Unterbrechung.')).toBeLessThan(
      markdown.indexOf('Der Originaltext bleibt unverändert'),
    );
  });

  it('creates new profiles and performs optimistic updates for existing profiles', async () => {
    const content = starterProfileContent();
    const created = persistedProfile(content);
    const createProfile = vi.fn(async () => ({ profile: created }));
    const updateProfile = vi.fn(async () => ({ profile: created }));
    const api = stubApi({ createProfile, updateProfile });

    await expect(saveProfile(api, content, null)).resolves.toEqual(created);
    expect(createProfile).toHaveBeenCalledWith({ profile: content });

    await expect(
      saveProfile(api, content, {
        profileId: created.profileId,
        updatedAt: created.updatedAt,
      }),
    ).resolves.toEqual(created);
    expect(updateProfile).toHaveBeenCalledWith(created.profileId, {
      profile: content,
      expectedUpdatedAt: created.updatedAt,
    });
  });

  it.each(['de', 'en'] as const)(
    'exports an unfinished %s transcript without a fabricated end or partial answer',
    (language) => {
      const session = mvpInterviewSessionSchema.parse({
        interviewId: 'unfinished',
        guideId: 'guide',
        guideTitle: 'Original guide',
        language,
        status: 'paused',
        currentQuestionIndex: 0,
        totalQuestions: 2,
        currentQuestion: null,
        startedAt: null,
        endedAt: null,
        updatedAt: '2026-10-01T10:00:00.000Z',
        finalizedAt: null,
        partialTranscript: 'UNCONFIRMED_PARTIAL',
        transcript: [],
      });
      const markdown = createInterviewTranscriptMarkdown({
        summary: {
          interviewId: session.interviewId,
          guideId: session.guideId,
          guideTitle: session.guideTitle,
          language,
          status: 'paused',
          currentMainQuestionId: null,
          activeWorkflowRunId: null,
          createdAt: session.updatedAt,
          updatedAt: session.updatedAt,
          startedAt: null,
        },
        session,
      });
      expect(markdown).toContain(
        language === 'de' ? 'Ende: Noch nicht beendet' : 'Ended: Not ended yet',
      );
      expect(markdown).toContain(language === 'de' ? 'Fehlende' : 'Missing');
      expect(markdown).not.toContain('UNCONFIRMED_PARTIAL');
      expect(markdown).not.toContain('1970');
    },
  );

  it('confirms imports through the canonical JSON endpoint for create and replace', async () => {
    const content = starterProfileContent();
    const profile = persistedProfile(content);
    const document = portableDocument(profile);
    const preview: ImportPreview = { kind: 'json', fileName: 'profile.json', document };
    const confirmJsonImport = vi.fn(async () => ({ profile }));
    const api = stubApi({ confirmJsonImport });

    await confirmImport(api, preview, null);
    await confirmImport(api, preview, {
      profileId: profile.profileId,
      updatedAt: profile.updatedAt,
    });

    expect(confirmJsonImport).toHaveBeenNthCalledWith(1, { mode: 'create', document });
    expect(confirmJsonImport).toHaveBeenNthCalledWith(2, {
      mode: 'replace',
      targetProfileId: profile.profileId,
      expectedUpdatedAt: profile.updatedAt,
      document,
    });
  });

  it('captures an immutable import replacement target at dialog open time', () => {
    const profile = persistedProfile(starterProfileContent());
    const target = captureImportReplaceTarget(profile);

    expect(target).toEqual({
      profileId: profile.profileId,
      name: profile.name,
      updatedAt: profile.updatedAt,
    });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('uses the server-normalized JSON preview and reports invalid JSON precisely', async () => {
    const profile = persistedProfile(starterProfileContent());
    const portable = portableDocument(profile).profile;
    const previewJsonImport = vi.fn(async () => ({ valid: true as const, profile: portable }));
    const api = stubApi({ previewJsonImport });

    const preview = await previewJsonFile(
      api,
      new File([JSON.stringify({ arbitrary: 'input' })], 'profile.json', {
        type: 'application/json',
      }),
    );

    expect(preview.document.profile).toEqual(portable);
    expect(previewJsonImport).toHaveBeenCalledWith({ arbitrary: 'input' });

    const failure = await previewJsonFile(
      api,
      new File(['{'], 'broken.json', { type: 'application/json' }),
    ).catch((reason: unknown) => operationError(reason, 'Import fehlgeschlagen.'));
    expect(failure).toMatchObject({
      conflict: false,
      fieldErrors: [{ path: ['file'], code: 'invalid_json' }],
    });
  });

  it('rejects oversized JSON files before reading or calling the preview API', async () => {
    const previewJsonImport = vi.fn(async () => {
      throw new Error('Preview must not be called');
    });
    const api = stubApi({ previewJsonImport });
    const text = vi.fn(async () => '{}');
    const file = {
      name: 'oversized.json',
      type: 'application/json',
      size: EVALUATION_PROFILE_JSON_IMPORT_MAXIMUM_FILE_BYTES + 1,
      text,
    } as unknown as File;

    const failure = await previewJsonFile(api, file).catch((reason: unknown) =>
      operationError(reason, 'Import fehlgeschlagen.'),
    );

    expect(failure).toMatchObject({
      retryable: false,
      fieldErrors: [{ path: ['file', 'size'], code: 'file_too_large' }],
    });
    expect(text).not.toHaveBeenCalled();
    expect(previewJsonImport).not.toHaveBeenCalled();
  });

  it('formats XLSX cells as one-based workbook coordinates and JSON indexes separately', () => {
    expect(formatFieldPath(['sheets', 'Items', 'rows', 3, 'columns', 'B'])).toBe('Items!B3');
    expect(formatFieldPath(['sheets', 'Anchors', 'rows', 2, 'columns', 'D'])).toBe('Anchors!D2');
    expect(formatFieldPath(['profile', 'items', 0, 'anchors', 1, 'criterion'])).toBe(
      'profile / items / Eintrag 1 / anchors / Eintrag 2 / criterion',
    );
  });

  it('keeps a 409 conflict and field errors available to the editor', () => {
    const result = operationError(
      new ApiError({
        kind: 'http',
        status: 409,
        code: 'CONFLICT',
        message: 'Profil wurde parallel geändert.',
        retryable: false,
        requestId: 'request-1',
        fieldErrors: [{ path: ['expectedUpdatedAt'], code: 'stale', message: 'Veraltet.' }],
      }),
      'Speichern fehlgeschlagen.',
    );

    expect(result).toEqual({
      message: 'Profil wurde parallel geändert.',
      conflict: true,
      retryable: false,
      requestId: 'request-1',
      fieldErrors: [{ path: ['expectedUpdatedAt'], code: 'stale', message: 'Veraltet.' }],
    });
  });
});

function persistedProfile(content: EvaluationProfileContent): EvaluationProfile {
  return evaluationProfileSchema.parse({
    profileId: 'profile-test',
    ...content,
    isDefault: false,
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
  });
}

function portableDocument(profile: EvaluationProfile): EvaluationProfileDocument {
  return {
    schemaVersion: 1,
    profile: {
      profileId: profile.profileId,
      name: profile.name,
      description: profile.description,
      coderPrompt: profile.coderPrompt,
      scale: profile.scale,
      dimensions: profile.dimensions,
      items: profile.items,
    },
  };
}

function stubApi(overrides: Partial<EvaluationStudioApi>): EvaluationStudioApi {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected API call');
  };
  return {
    listProfiles: unexpected,
    getProfile: unexpected,
    createProfile: unexpected,
    updateProfile: unexpected,
    duplicateProfile: unexpected,
    deleteProfile: unexpected,
    exportProfile: unexpected,
    getJsonTemplate: unexpected,
    getXlsxTemplate: unexpected,
    getLockedGuardrails: unexpected,
    previewJsonImport: unexpected,
    previewXlsxImport: unexpected,
    confirmJsonImport: unexpected,
    listEvaluableInterviews: unexpected,
    renameInterview: unexpected,
    deleteInterview: unexpected,
    getEvaluation: unexpected,
    startEvaluation: unexpected,
    retryEvaluation: unexpected,
    getEvaluationExport: unexpected,
    ...overrides,
  };
}
