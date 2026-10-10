import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { compose, openingView, type Composed } from './app/compose.ts';
import './ui/fonts.css';
import './ui/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('daily-commit: #root is missing from index.html');
const show = (made: Composed | undefined) => {
  createRoot(root).render(<StrictMode>{openingView(made) === 'ready' && made?.kind === 'Ready' ? <App deps={made.deps} /> : null}</StrictMode>);
};
void compose().then(show, () => show(undefined));
