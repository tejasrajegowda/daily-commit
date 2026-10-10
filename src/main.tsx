import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { compose } from './app/compose.ts';
import './ui/fonts.css';
import './ui/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('daily-commit: #root is missing from index.html');
void compose().then(made => {
  createRoot(root).render(<StrictMode>{made.kind === 'Ready' ? <App deps={made.deps} /> : null}</StrictMode>);
});
