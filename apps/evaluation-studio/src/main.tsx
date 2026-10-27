import '@orgscience/design-tokens/tokens.css';
import { LocaleConsumer, LocaleProvider } from '@orgscience/frontend-i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { StudioErrorBoundary } from './components/StudioErrorBoundary.js';
import './styles.css';
import { STUDIO_UI_LOCALE_STORAGE_KEY } from './studio-app-copy.js';

const root = document.querySelector<HTMLElement>('#root');
if (root === null) throw new Error('Evaluation Studio root element is missing');

createRoot(root).render(
  <StrictMode>
    <LocaleProvider storageKey={STUDIO_UI_LOCALE_STORAGE_KEY}>
      <LocaleConsumer>
        {({ locale }) => (
          <StudioErrorBoundary language={locale}>
            <App />
          </StudioErrorBoundary>
        )}
      </LocaleConsumer>
    </LocaleProvider>
  </StrictMode>,
);
