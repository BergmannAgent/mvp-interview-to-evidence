import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StudioErrorBoundary } from './StudioErrorBoundary.js';

describe('StudioErrorBoundary language', () => {
  it('uses the English failure state by default', () => {
    const boundary = new StudioErrorBoundary({ children: null });
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render())).toContain(
      'You can reload the page without losing data.',
    );
  });

  it('keeps the German failure state for a German UI preference', () => {
    const boundary = new StudioErrorBoundary({ children: null, language: 'de' });
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render())).toContain(
      'Die Seite kann ohne Datenverlust neu geladen werden.',
    );
  });

  it('uses English failure and reload labels when configured', () => {
    const boundary = new StudioErrorBoundary({ children: null, language: 'en' });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('Evaluation Studio could not be displayed');
    expect(html).toContain('You can reload the page without losing data.');
    expect(html).toContain('Reload');
    expect(html).not.toContain('Neu laden');
  });
});
