import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Carl Desktop could not find its mount point.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/*
 * The boot mark in index.html is painted before this bundle exists, so that a till starting
 * on a cold shop machine shows Carl rather than an empty window. It is removed here rather
 * than left to CSS alone: `display: none` would keep an element the screen reader still
 * walks past, and the till is used by people with the screen reader on.
 */
document.getElementById('boot')?.remove();
