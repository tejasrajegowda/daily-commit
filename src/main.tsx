import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/fonts.css';
import './ui/app.css';

// The empty, correctly shaped app, with the design's stylesheet. Screens arrive in U4's next tasks.
function App() {
  return <main className="app" aria-label="Daily Commit" />;
}

const root = document.getElementById('root');
if (!root) throw new Error('daily-commit: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
