import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { App } from '@/App';
import { initViewportTracking } from '@/lib/viewport';
import { installBrowserCrashReporting } from '@/lib/crashReports';
import './index.css';

// Keyboard-aware viewport variables must exist before anything renders.
initViewportTracking();
// A crash nothing caught is reported (scrubbed, and only if this is a tester installation).
installBrowserCrashReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
