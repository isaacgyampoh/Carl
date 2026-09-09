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
