import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { APP_VERSION, compose, openingView, type Composed } from './app/compose.ts';
import { StartFailed } from './app/StartFailed.tsx';
import { TooOld } from './app/TooOld.tsx';
import './ui/fonts.css';
import './ui/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('daily-commit: #root is missing from index.html');
const show = (made: Composed | undefined) => {
  const view = openingView(made);
  createRoot(root).render(<StrictMode>{
    view === 'ready' && made?.kind === 'Ready' ? <App deps={made.deps} />
      : view === 'too-old' ? <TooOld version={APP_VERSION} />
        : <StartFailed version={APP_VERSION} step={made?.kind === 'StartFailed' ? made.step : 'app'} error={made?.kind === 'StartFailed' ? made.error : 'Error'} />
  }</StrictMode>);
};
void compose().then(show, () => show(undefined));
