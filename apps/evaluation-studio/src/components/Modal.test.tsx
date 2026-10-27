import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Modal, nextModalFocusIndex } from './Modal.js';

describe('Modal', () => {
  it('cycles forwards and backwards without leaving the dialog', () => {
    expect(nextModalFocusIndex(-1, 3, false)).toBe(0);
    expect(nextModalFocusIndex(-1, 3, true)).toBe(2);
    expect(nextModalFocusIndex(2, 3, false)).toBe(0);
    expect(nextModalFocusIndex(0, 3, true)).toBe(2);
    expect(nextModalFocusIndex(1, 3, false)).toBe(2);
    expect(nextModalFocusIndex(0, 0, false)).toBe(-1);
  });

  it('renders one labelled modal layer with an explicit initial focus control', () => {
    const html = renderToStaticMarkup(
      <Modal
        title="Testdialog"
        description="Dialogbeschreibung"
        onClose={() => undefined}
        footer={<button type="button">Abbrechen</button>}
      >
        <button type="button" data-modal-initial-focus>
          Start
        </button>
      </Modal>,
    );

    expect(html.match(/role="dialog"/gu) ?? []).toHaveLength(1);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-modal-layer="true"');
    expect(html).toContain('data-modal-initial-focus="true"');
  });
});
