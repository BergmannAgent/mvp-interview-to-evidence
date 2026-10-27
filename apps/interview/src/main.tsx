import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { InterviewRoot } from './app/InterviewRoot.js';
import './styles.css';

const rootElement = document.querySelector<HTMLElement>('#root');
if (rootElement === null) throw new Error('The application root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <InterviewRoot />
  </StrictMode>,
);
