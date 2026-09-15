import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { BootBoundary } from './ui/boot-boundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Carl Desktop could not find its mount point.');

/*
 * The boot mark from index.html is cleared by BootBoundary on mount, not here.
 *
 * It used to be removed on the line after this one, which looks equivalent and is not:
 * `render()` returns before anything has been drawn, so a component that threw on its first
 * render left a window with the mark already gone and nothing to replace it — blank.
 */
createRoot(root).render(
  <StrictMode>
    <BootBoundary>
      <App />
    </BootBoundary>
  </StrictMode>,
);
