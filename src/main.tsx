import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// U0: the empty, correctly shaped app. Screens arrive in U4.
function App() {
  return <main style={{ minHeight: '100dvh', background: '#000' }} aria-label="Daily Commit" />;
}

const root = document.getElementById('root');
if (!root) throw new Error('daily-commit: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
