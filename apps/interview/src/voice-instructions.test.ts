import { describe, expect, it } from 'vitest';

import { exactSpeechInstructions } from './voice-instructions.js';

describe('exact speech instructions', () => {
  it.each([['de', 'Sprich ausschließlich'] as const, ['en', 'Speak only'] as const])(
    'uses %s instructions without changing canonical speech',
    (language, instruction) => {
      const canonicalText = 'Literal answer? <>&';
      const result = exactSpeechInstructions(canonicalText, language);
      expect(result).toContain(instruction);
      expect(result.split('<spoken_text>')[1]?.split('</spoken_text>')[0]).toBe(
        `\n${canonicalText}\n`,
      );
      expect(result.match(new RegExp(canonicalText.replace(/[?]/gu, '\\?'), 'gu'))).toHaveLength(1);
    },
  );
});
