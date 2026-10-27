import { describe, expect, it } from 'vitest';

import { profileUiError } from './profile-ui-errors.js';

describe('profile UI errors', () => {
  it('localizes known validation and JSON errors only for English UI', () => {
    expect(profileUiError('Dieses Feld darf nicht leer sein.', 'en')).toBe(
      'This field must not be blank.',
    );
    expect(profileUiError('Die Datei enthält kein gültiges JSON.', 'en')).toBe(
      'The file does not contain valid JSON.',
    );
    expect(profileUiError('JSON-Syntax prüfen.', 'en')).toBe('Check the JSON syntax.');
    expect(profileUiError('Too small: expected string to have >=1 characters', 'en')).toBe(
      'This field must not be blank.',
    );
    expect(profileUiError('Too small: expected string to have >=1 characters', 'de')).toBe(
      'Dieses Feld darf nicht leer sein.',
    );
    expect(profileUiError('Dieses Feld darf nicht leer sein.', 'de')).toBe(
      'Dieses Feld darf nicht leer sein.',
    );
  });

  it('preserves unknown technical details and original profile text', () => {
    expect(profileUiError('Unexpected response: request-123', 'en')).toBe(
      'Unexpected response: request-123',
    );
    expect(profileUiError('Im Team wird Verantwortung geteilt.', 'en')).toBe(
      'Im Team wird Verantwortung geteilt.',
    );
  });

  it('localizes calculation validation and runtime failures without altering expressions', () => {
    expect(profileUiError('The formula references an unknown item or dimension ID.', 'de')).toBe(
      'Die Formel verweist auf eine unbekannte Item- oder Dimensions-ID.',
    );
    expect(profileUiError('Division or remainder by zero is undefined.', 'de')).toBe(
      'Eine Division oder Restwertberechnung durch 0 ist nicht definiert.',
    );
    expect(profileUiError('The calculation produced a non-finite value.', 'de')).toBe(
      'Die Berechnung hat keinen endlichen Wert ergeben.',
    );
    expect(profileUiError('The formula references an unknown item or dimension ID.', 'en')).toBe(
      'The formula references an unknown item or dimension ID.',
    );
    expect(profileUiError('item("deutsches-item") + 8', 'de')).toBe('item("deutsches-item") + 8');
  });
});
