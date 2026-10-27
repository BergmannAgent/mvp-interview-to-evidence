import type { SupportedLocale } from '@orgscience/contracts';

import { monitoringMessagesDe, monitoringMessagesEn } from './monitoring-messages.js';

export type MessageVariables = Readonly<Record<string, number | string>>;

const de = {
  'common.language.label': 'Sprache',
  'common.language.de': 'Deutsch',
  'common.language.en': 'English',
  'common.localeName.de': 'Deutsch',
  'common.localeName.en': 'Englisch',
  'common.action.reload': 'Seite neu laden',
  'common.value.notAvailable': '–',
  'interview.meta.title': 'Fieldwork Interview',
  'interview.meta.description': 'Wissenschaftliche Experteninterviews mit Live-Transkript',
  'interview.brand.subtitle': 'Forschungsinterview',
  'interview.backend.ready': 'Backend bereit',
  'interview.language.interview': 'Interviewsprache',
  'interview.language.ui': 'Oberflächensprache',
  'interview.language.locked': 'Interviewsprache: {language}',
  'interview.preparation.eyebrow': 'Interview vorbereiten',
  'interview.preparation.title': 'Bereit für das Gespräch?',
  'interview.preparation.intro': 'Prüfen Sie Ihre Geräte und wählen Sie die Interviewsprache.',
  'interview.settings.title': 'Interview-Einstellungen',
  'interview.settings.guide': 'Leitfaden',
  'interview.settings.loading': 'Leitfaden wird geladen …',
  'interview.settings.save': 'Auswahl speichern',
  'interview.settings.close': 'Schließen',
  'interview.settings.unavailable': 'Kein Leitfaden für diese Sprache gespeichert.',
  'interview.preparation.uploadTitle': 'Markdown-Leitfaden auswählen',
  'interview.preparation.uploadHelp': 'Eine .md-Datei, maximal 1 MB',
  'interview.preparation.savedGuide': 'Gespeicherter Leitfaden',
  'interview.preparation.sectionCount.one': '{count} Abschnitt',
  'interview.preparation.sectionCount.many': '{count} Abschnitte',
  'interview.preparation.questionCount.one': '{count} Frage',
  'interview.preparation.questionCount.many': '{count} Fragen',
  'interview.preparation.changeGuide': 'Ändern',
  'interview.preparation.modeLabel': 'Interviewmodus',
  'interview.preparation.modeText': 'Text',
  'interview.preparation.modeVoice': 'Sprache',
  'interview.preparation.voiceProvider': 'OpenAI Voice',
  'interview.preparation.voiceNotice':
    'Beim Start wird eine verschlüsselte Realtime-Verbindung aufgebaut. Providerfehler werden sichtbar gemeldet.',
  'interview.preparation.start': 'Interview starten',
  'interview.participant.self': 'Sie',
  'interview.device.microphone.on': 'Mikrofon einschalten',
  'interview.device.microphone.off': 'Mikrofon ausschalten',
  'interview.device.camera.on': 'Kamera einschalten',
  'interview.device.camera.off': 'Kamera ausschalten',
  'interview.device.microphone.select': 'Mikrofon auswählen',
  'interview.device.camera.select': 'Kamera auswählen',
  'interview.device.microphone.default': 'Standardmikrofon',
  'interview.device.camera.default': 'Standardkamera',
  'interview.device.microphone.numbered': 'Mikrofon {number}',
  'interview.device.camera.numbered': 'Kamera {number}',
  'interview.device.error.enumeration':
    'Die verfügbaren Kamera- und Mikrofongeräte konnten nicht gelesen werden.',
  'interview.device.error.unsupported':
    'Dieser Browser unterstützt keine Kamera- oder Mikrofongeräte.',
  'interview.device.error.permission': 'Der Zugriff auf Kamera oder Mikrofon wurde nicht erlaubt.',
  'interview.ai.name': 'Dr. Ada',
  'interview.ai.label': 'KI-Interviewer',
  'interview.meeting.phase.ready': 'Bereit',
  'interview.meeting.phase.listening': 'KI hört zu',
  'interview.meeting.phase.processing': 'KI verarbeitet',
  'interview.meeting.phase.speaking': 'KI spricht',
  'interview.meeting.phase.paused': 'Pausiert',
  'interview.meeting.phase.completed': 'Abgeschlossen',
  'interview.meeting.voice.failed': 'Voice-Fehler',
  'interview.meeting.voice.idle': 'Voice getrennt',
  'interview.meeting.voice.connecting': 'Voice verbindet',
  'interview.meeting.connection.connected': 'Live verbunden',
  'interview.meeting.connection.degraded': 'Verbindung unterbrochen',
  'interview.meeting.progress': 'Frage {current} von {total}',
  'interview.meeting.answer.label': 'Ihre Antwort',
  'interview.meeting.answer.paused': 'Interview pausiert',
  'interview.meeting.answer.processing': 'Antwort wird verarbeitet …',
  'interview.meeting.answer.placeholder': 'Ihre Antwort …',
  'interview.meeting.answer.send': 'Antwort senden',
  'interview.meeting.voice.processing': 'Ihre Antwort wird verarbeitet.',
  'interview.meeting.voice.listening': 'Sprechen Sie jetzt. Ihre Antwort wird live transkribiert.',
  'interview.meeting.voice.muted': 'Das Mikrofon ist ausgeschaltet.',
  'interview.meeting.voice.disconnected': 'Voice ist nicht verbunden.',
  'interview.meeting.mode.text': 'Textmodus',
  'interview.meeting.mode.voice': 'OpenAI Voice',
  'interview.meeting.voice.connect': 'Voice verbinden',
  'interview.meeting.captions.on': 'Untertitel einschalten',
  'interview.meeting.captions.off': 'Untertitel ausschalten',
  'interview.meeting.transcript.open': 'Transkript öffnen',
  'interview.meeting.transcript.close': 'Transkript schließen',
  'interview.meeting.pause': 'Interview pausieren',
  'interview.meeting.resume': 'Interview fortsetzen',
  'interview.meeting.end': 'Interview beenden',
  'interview.meeting.turnCount.one': '{count} Turn',
  'interview.meeting.turnCount.many': '{count} Turns',
  'interview.transcript.aria': 'Live-Transkript',
  'interview.transcript.eyebrow': 'Live-Transkript',
  'interview.transcript.title': 'Gespräch',
  'interview.transcript.close': 'Transkript schließen',
  'interview.transcript.empty': 'Das Transkript beginnt mit der ersten gesprochenen Frage.',
  'interview.transcript.speaker.ai': 'KI-Interviewer',
  'interview.transcript.speaker.participant': 'Sie',
  'interview.transcript.final': 'Final',
  'interview.completion.eyebrow': 'Interview abgeschlossen',
  'interview.completion.summary':
    'Das Gespräch wurde vollständig in der kanonischen Reihenfolge erfasst.',
  'interview.completion.interviewId': 'Interview-ID',
  'interview.completion.duration': 'Dauer',
  'interview.completion.turns': 'Transkript-Turns',
  'interview.completion.evaluationPendingTitle':
    'Die Auswertung ist nach der Transkriptfinalisierung verfügbar',
  'interview.completion.evaluationPending': 'Auswertung wird vorbereitet',
  'interview.completion.openEvaluation': 'OR-Auswertung öffnen',
  'interview.completion.restart': 'Neues Interview',
  'interview.completion.transcriptAria': 'Finales Transkript',
  'interview.completion.artifact': 'Forschungsartefakt',
  'interview.completion.transcriptTitle': 'Finales Transkript',
  'interview.completion.finalizationPending': 'Finalisierung ausstehend',
  'interview.completion.finalized': 'Finalisiert',
  'interview.completion.exportPendingTitle':
    'Der Export ist nach der kanonischen Transkriptfinalisierung verfügbar.',
  'interview.completion.technicalGap': 'Technische Lücke',
  'interview.completion.speaker.ai': 'KI-Interviewer',
  'interview.completion.speaker.participant': 'Interviewpartner',
  'interview.error.fileExtension': 'Bitte wählen Sie eine Markdown-Datei mit der Endung .md aus.',
  'interview.error.fileSize': 'Der Leitfaden darf höchstens 1 MB groß sein.',
  'interview.error.network': 'Das Backend ist derzeit nicht erreichbar.',
  'interview.error.invalidResponse': 'Der Server hat eine unerwartete Antwort geliefert.',
  'interview.error.guideInvalid':
    'Der Leitfaden entspricht nicht der erwarteten Markdown-Struktur.',
  'interview.error.languageConflict':
    'Die Sprache des Leitfadens stimmt nicht mit der Interviewsprache überein.',
  'interview.error.stateConflict':
    'Die Aktion steht im Konflikt mit dem aktuellen Interviewzustand. Bitte laden Sie den Stand neu.',
  'interview.error.notFound': 'Das Interview wurde nicht gefunden.',
  'interview.error.clientUpdate':
    'Die Anwendung wurde aktualisiert. Bitte laden Sie die Seite neu.',
  'interview.error.voice':
    'Die Voice-Verbindung ist fehlgeschlagen. Bitte verbinden Sie das Mikrofon erneut.',
  'interview.error.voiceConfiguration':
    'OpenAI Voice ist nicht konfiguriert. Hinterlegen Sie OPENAI_API_KEY und starten Sie den Stack neu.',
  'interview.error.voiceConfigurationInvalid':
    'Die OpenAI-Voice-Konfiguration ist ungültig. Prüfen Sie die Voice-Einstellungen und starten Sie den Stack neu.',
  'interview.error.voiceRateLimited':
    'OpenAI Voice ist wegen eines API-Limits nicht verfügbar. Dieser Turn wird automatisch erneut versucht.',
  'interview.error.generic': 'Die Anfrage konnte nicht abgeschlossen werden.',
  'interview.error.renderTitle': 'Die Interviewansicht konnte nicht geladen werden.',
  'interview.error.renderBody':
    'Bitte laden Sie die Seite neu. Bereits gespeicherte Interviewdaten bleiben erhalten.',
  ...monitoringMessagesDe,
} as const;

export type MessageKey = keyof typeof de;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;

const en = {
  'common.language.label': 'Language',
  'common.language.de': 'Deutsch',
  'common.language.en': 'English',
  'common.localeName.de': 'German',
  'common.localeName.en': 'English',
  'common.action.reload': 'Reload page',
  'common.value.notAvailable': '–',
  'interview.meta.title': 'Fieldwork Interview',
  'interview.meta.description': 'Scientific expert interviews with a live transcript',
  'interview.brand.subtitle': 'Research interview',
  'interview.backend.ready': 'Backend ready',
  'interview.language.interview': 'Interview language',
  'interview.language.ui': 'Interface language',
  'interview.language.locked': 'Interview language: {language}',
  'interview.preparation.eyebrow': 'Prepare interview',
  'interview.preparation.title': 'Ready for the interview?',
  'interview.preparation.intro': 'Check your devices and choose the interview language.',
  'interview.settings.title': 'Interview settings',
  'interview.settings.guide': 'Interview guide',
  'interview.settings.loading': 'Loading interview guide …',
  'interview.settings.save': 'Save selection',
  'interview.settings.close': 'Close',
  'interview.settings.unavailable': 'No interview guide is configured for this language.',
  'interview.preparation.uploadTitle': 'Select Markdown guide',
  'interview.preparation.uploadHelp': 'One .md file, up to 1 MB',
  'interview.preparation.savedGuide': 'Saved interview guide',
  'interview.preparation.sectionCount.one': '{count} section',
  'interview.preparation.sectionCount.many': '{count} sections',
  'interview.preparation.questionCount.one': '{count} question',
  'interview.preparation.questionCount.many': '{count} questions',
  'interview.preparation.changeGuide': 'Change',
  'interview.preparation.modeLabel': 'Interview mode',
  'interview.preparation.modeText': 'Text',
  'interview.preparation.modeVoice': 'Voice',
  'interview.preparation.voiceProvider': 'OpenAI Voice',
  'interview.preparation.voiceNotice':
    'An encrypted Realtime connection is established when the interview starts. Provider errors are reported visibly.',
  'interview.preparation.start': 'Start interview',
  'interview.participant.self': 'You',
  'interview.device.microphone.on': 'Turn microphone on',
  'interview.device.microphone.off': 'Turn microphone off',
  'interview.device.camera.on': 'Turn camera on',
  'interview.device.camera.off': 'Turn camera off',
  'interview.device.microphone.select': 'Select microphone',
  'interview.device.camera.select': 'Select camera',
  'interview.device.microphone.default': 'Default microphone',
  'interview.device.camera.default': 'Default camera',
  'interview.device.microphone.numbered': 'Microphone {number}',
  'interview.device.camera.numbered': 'Camera {number}',
  'interview.device.error.enumeration':
    'The available camera and microphone devices could not be read.',
  'interview.device.error.unsupported':
    'This browser does not support camera or microphone devices.',
  'interview.device.error.permission': 'Access to the camera or microphone was not granted.',
  'interview.ai.name': 'Dr. Ada',
  'interview.ai.label': 'AI interviewer',
  'interview.meeting.phase.ready': 'Ready',
  'interview.meeting.phase.listening': 'AI is listening',
  'interview.meeting.phase.processing': 'AI is processing',
  'interview.meeting.phase.speaking': 'AI is speaking',
  'interview.meeting.phase.paused': 'Paused',
  'interview.meeting.phase.completed': 'Completed',
  'interview.meeting.voice.failed': 'Voice error',
  'interview.meeting.voice.idle': 'Voice disconnected',
  'interview.meeting.voice.connecting': 'Connecting voice',
  'interview.meeting.connection.connected': 'Connected live',
  'interview.meeting.connection.degraded': 'Connection interrupted',
  'interview.meeting.progress': 'Question {current} of {total}',
  'interview.meeting.answer.label': 'Your answer',
  'interview.meeting.answer.paused': 'Interview paused',
  'interview.meeting.answer.processing': 'Processing answer …',
  'interview.meeting.answer.placeholder': 'Your answer …',
  'interview.meeting.answer.send': 'Send answer',
  'interview.meeting.voice.processing': 'Your answer is being processed.',
  'interview.meeting.voice.listening': 'Speak now. Your answer is transcribed live.',
  'interview.meeting.voice.muted': 'The microphone is muted.',
  'interview.meeting.voice.disconnected': 'Voice is not connected.',
  'interview.meeting.mode.text': 'Text mode',
  'interview.meeting.mode.voice': 'OpenAI Voice',
  'interview.meeting.voice.connect': 'Connect voice',
  'interview.meeting.captions.on': 'Turn captions on',
  'interview.meeting.captions.off': 'Turn captions off',
  'interview.meeting.transcript.open': 'Open transcript',
  'interview.meeting.transcript.close': 'Close transcript',
  'interview.meeting.pause': 'Pause interview',
  'interview.meeting.resume': 'Resume interview',
  'interview.meeting.end': 'End interview',
  'interview.meeting.turnCount.one': '{count} turn',
  'interview.meeting.turnCount.many': '{count} turns',
  'interview.transcript.aria': 'Live transcript',
  'interview.transcript.eyebrow': 'Live transcript',
  'interview.transcript.title': 'Conversation',
  'interview.transcript.close': 'Close transcript',
  'interview.transcript.empty': 'The transcript begins with the first spoken question.',
  'interview.transcript.speaker.ai': 'AI interviewer',
  'interview.transcript.speaker.participant': 'You',
  'interview.transcript.final': 'Final',
  'interview.completion.eyebrow': 'Interview completed',
  'interview.completion.summary': 'The conversation was captured completely in canonical order.',
  'interview.completion.interviewId': 'Interview ID',
  'interview.completion.duration': 'Duration',
  'interview.completion.turns': 'Transcript turns',
  'interview.completion.evaluationPendingTitle':
    'The evaluation will be available after transcript finalisation',
  'interview.completion.evaluationPending': 'Preparing evaluation',
  'interview.completion.openEvaluation': 'Open OR evaluation',
  'interview.completion.restart': 'New interview',
  'interview.completion.transcriptAria': 'Final transcript',
  'interview.completion.artifact': 'Research artifact',
  'interview.completion.transcriptTitle': 'Final transcript',
  'interview.completion.finalizationPending': 'Finalisation pending',
  'interview.completion.finalized': 'Finalised',
  'interview.completion.exportPendingTitle':
    'Export is available after canonical transcript finalisation.',
  'interview.completion.technicalGap': 'Technical gap',
  'interview.completion.speaker.ai': 'AI interviewer',
  'interview.completion.speaker.participant': 'Participant',
  'interview.error.fileExtension': 'Please select a Markdown file with the .md extension.',
  'interview.error.fileSize': 'The interview guide must not exceed 1 MB.',
  'interview.error.network': 'The backend is currently unavailable.',
  'interview.error.invalidResponse': 'The server returned an unexpected response.',
  'interview.error.guideInvalid': 'The guide does not match the expected Markdown structure.',
  'interview.error.languageConflict': 'The guide language does not match the interview language.',
  'interview.error.stateConflict':
    'The action conflicts with the current interview state. Please reload the latest state.',
  'interview.error.notFound': 'The interview was not found.',
  'interview.error.clientUpdate': 'The application was updated. Please reload the page.',
  'interview.error.voice': 'The voice connection failed. Please reconnect the microphone.',
  'interview.error.voiceConfiguration':
    'OpenAI Voice is not configured. Set OPENAI_API_KEY and restart the stack.',
  'interview.error.voiceConfigurationInvalid':
    'The OpenAI Voice configuration is invalid. Check the Voice settings and restart the stack.',
  'interview.error.voiceRateLimited':
    'OpenAI Voice is unavailable because of an API limit. This turn will be retried automatically.',
  'interview.error.generic': 'The request could not be completed.',
  'interview.error.renderTitle': 'The interview view could not be loaded.',
  'interview.error.renderBody':
    'Please reload the page. Previously saved interview data will be retained.',
  ...monitoringMessagesEn,
} as const satisfies MessageCatalog;

export const messageCatalogs = Object.freeze({ de, en } satisfies Readonly<
  Record<SupportedLocale, MessageCatalog>
>);

export interface TranslateOptions {
  readonly reportMissing?: (description: string) => void;
}

export type Translate = (key: MessageKey, variables?: MessageVariables) => string;

export function translate(
  locale: SupportedLocale,
  key: MessageKey,
  variables: MessageVariables = {},
  options: TranslateOptions = {},
): string {
  const template: string | undefined = messageCatalogs[locale][key];
  if (template === undefined) {
    const marker = `⟦${key}⟧`;
    options.reportMissing?.(`Missing message: ${key} (${locale})`);
    return marker;
  }
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, variable: string) => {
    const value = variables[variable];
    if (value !== undefined) return String(value);
    options.reportMissing?.(`Missing variable: ${key}.${variable} (${locale})`);
    return `⟦${variable}⟧`;
  });
}
