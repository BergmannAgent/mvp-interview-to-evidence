import {
  calculateProfileScores,
  type EvaluationProfileContent,
  type SupportedLocale,
} from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  addItem,
  starterProfileContent,
  updateCalculation,
  updateItem,
  updateItemWeight,
  validateDraft,
} from '../profile-draft.js';
import {
  CalculationEditor,
  insertFormulaReference,
  previewScores,
  WeightField,
  type FormulaReferenceFunction,
} from './CalculationEditor.js';

describe('CalculationEditor', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'renders and previews a legitimate %s item ID with no inherited test value',
    (itemId) => {
      const content = updateItem(starterProfileContent(), 0, 'itemId', itemId);
      expect(previewScores(content, {})?.get(itemId)).toBeNull();
      expect(previewScores(content, { [itemId]: '6' })?.get(itemId)).toBe(6);
      expect(() => renderEditor(content)).not.toThrow();
    },
  );

  it('renders the legacy weighted mode with missing scores rather than invented test data', () => {
    const html = renderEditor(starterProfileContent());
    expect(html).toContain('Gewichtetes Mittel');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Lokale Testvorschau');
    expect(html).toContain('Nicht berechnet');
    expect(html).toContain('placeholder="Fehlend"');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('/ 7');
  });

  it('renders all stable-ID insertion functions and an unbounded local formula result', () => {
    const content = updateCalculation(starterProfileContent(), {
      mode: 'formula',
      expression: 'item("item-1") + 10',
    });
    const html = renderEditor(content, 'en');
    expect(html).toContain('Formula expression');
    for (const fn of ['item', 'dimension', 'itemWeight', 'dimensionWeight']) {
      expect(html).toContain(`value="${fn}"`);
    }
    expect(html).toContain('value="item-1"');
    expect(html).toContain('aria-label="Insert reference"');
    expect(html).toContain('Substituted with 0 in formulas');
    expect(html).toContain('Unbounded');
    expect(html).toContain('<strong>10</strong>');
    expect(html).toContain('Test score: Item 1');
    expect(html).not.toContain('Gewichtetes Mittel');
  });

  it.each(['de', 'en'] as const)(
    'keeps large finite formula preview results compact in %s',
    (locale) => {
      for (const result of [1e9, -1e9, 1e308, -1e308]) {
        const content = updateCalculation(starterProfileContent(), {
          mode: 'formula',
          expression: String(result),
        });
        const original = structuredClone(content);
        expect(validateDraft(content).valid).toBe(true);
        expect(calculateProfileScores(content, {}).overallAggregate.score).toBe(result);
        const html = renderEditor(content, locale);
        const output = html.match(/<output[\s\S]*?<\/output>/u)?.[0] ?? '';
        const displayed = output.match(/<strong>([^<]*)<\/strong>/u)?.[1];
        const formatted = new Intl.NumberFormat(locale, {
          maximumFractionDigits: 2,
          notation: 'scientific',
        }).format(result);

        expect(displayed).toBe(formatted);
        expect(formatted.length).toBeLessThan(12);
        expect(output).not.toContain('/7');
        expect(content).toEqual(original);
      }
    },
  );

  it('connects broken formula references to the editor and localizes the error', () => {
    const content = updateItem(
      updateCalculation(starterProfileContent(), {
        mode: 'formula',
        expression: 'item("item-1")',
      }),
      0,
      'itemId',
      'item-renamed',
    );
    const german = renderEditor(content);
    const english = renderEditor(content, 'en');
    expect(german).toContain('aria-describedby="calculation-expression-error"');
    expect(german).toContain('Die Formel verweist auf eine unbekannte Item- oder Dimensions-ID.');
    expect(english).toContain('The formula references an unknown item or dimension ID.');
    expect(german).toContain('item(&quot;item-1&quot;)');
    expect(english).not.toContain('Die Formel verweist');
  });

  it('localizes runtime errors from the local calculation without saving or calling an API', () => {
    const content = updateCalculation(starterProfileContent(), {
      mode: 'formula',
      expression: '1 / item("item-1")',
    });
    expect(renderEditor(content)).toContain(
      'Eine Division oder Restwertberechnung durch 0 ist nicht definiert.',
    );
    expect(renderEditor(content, 'en')).toContain('Division or remainder by zero is undefined.');
  });

  it('disables every editable calculation control while busy', () => {
    const content = updateCalculation(starterProfileContent(), {
      mode: 'formula',
      expression: 'dimension("dimension-1")',
    });
    const html = renderEditor(content, 'en', true);
    for (const control of html.matchAll(/<(?:button|input|select|textarea)\b[^>]*>/gu)) {
      expect(control[0]).toContain('disabled');
    }
  });

  it('inserts safely quoted reference IDs at the caret or replaces the selected text', () => {
    for (const fn of [
      'item',
      'dimension',
      'itemWeight',
      'dimensionWeight',
    ] as const satisfies readonly FormulaReferenceFunction[]) {
      const reference = `${fn}("stable-id")`;
      expect(insertFormulaReference('1 + old + 2', fn, 'stable-id', 4, 7)).toEqual({
        expression: `1 + ${reference} + 2`,
        cursor: 4 + reference.length,
      });
    }
    expect(insertFormulaReference('', 'item', 'quoted"id', 0, 0).expression).toBe(
      'item("quoted\\"id")',
    );
    expect(insertFormulaReference('2', 'item', 'id', 999, 999).expression).toBe('2item("id")');
  });

  it('treats blank local test inputs as missing and validates the locked item score range', () => {
    const content = addItem(starterProfileContent(), 0);
    expect(previewScores(content, { 'item-1': '3', 'item-2': '' })).toEqual(
      new Map([
        ['item-1', 3],
        ['item-2', null],
      ]),
    );
    expect(previewScores(content, {})).toEqual(
      new Map([
        ['item-1', null],
        ['item-2', null],
      ]),
    );
    for (const score of ['0', '8', '2.5', 'NaN', 'Infinity']) {
      expect(previewScores(content, { 'item-1': score })).toBeNull();
    }
    const weighted = updateItemWeight(content, 1, 3);
    const scores = previewScores(weighted, { 'item-1': '1', 'item-2': '7' });
    expect(scores).not.toBeNull();
    expect(calculateProfileScores(weighted, scores ?? new Map()).overallAggregate.score).toBe(5.5);
  });

  it('shows default and zero weights and connects invalid weights to localized errors', () => {
    const render = (value: number | undefined, locale: SupportedLocale): string =>
      renderLocalized(
        <WeightField
          id="test-weight"
          label="Weight"
          value={value}
          error={null}
          disabled={false}
          onChange={() => undefined}
        />,
        locale,
      );
    expect(render(undefined, 'en')).toContain('value="1"');
    expect(render(0, 'en')).toContain('value="0"');
    const invalid = render(NaN, 'de');
    expect(invalid).toContain('aria-describedby="test-weight-error"');
    expect(invalid).toContain('Das Gewicht muss eine endliche Zahl');
    expect(render(-1, 'en')).toContain('The weight must be a finite number');
  });
});

function renderEditor(
  content: EvaluationProfileContent,
  locale: SupportedLocale = 'de',
  disabled = false,
): string {
  return renderLocalized(
    <CalculationEditor
      content={content}
      validation={validateDraft(content)}
      disabled={disabled}
      onChange={() => undefined}
    />,
    locale,
  );
}

function renderLocalized(node: ReactNode, locale: SupportedLocale): string {
  return renderToStaticMarkup(<LocaleProvider lockedLocale={locale}>{node}</LocaleProvider>);
}
