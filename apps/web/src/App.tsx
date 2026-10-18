import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom';
import { isStaticBuild } from './lib/api';
import { useAuth } from './state/auth';
import { Toasts } from './components/Toasts';
import { RouteFallback } from './components/RouteFallback';

const Landing = lazy(() => import('./landing/Landing'));
const Workspace = lazy(() => import('./workspace/Workspace'));
const MathPage = lazy(() => import('./pages/MathPage'));
const SignIn = lazy(() => import('./auth/AuthPages').then((m) => ({ default: m.SignIn })));
const Register = lazy(() => import('./auth/AuthPages').then((m) => ({ default: m.Register })));
const Account = lazy(() => import('./auth/Account'));
const Report = lazy(() => import('./report/Report'));
const NotFound = lazy(() => import('./pages/NotFound'));

export function App() {
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const Router = isStaticBuild ? HashRouter : BrowserRouter;
  return (
    <Router>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/workspace/:scenarioId" element={<Workspace />} />
          <Route path="/mathematics" element={<MathPage />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/register" element={<Register />} />
          <Route path="/account" element={<Account />} />
          <Route path="/report" element={<Report />} />
          <Route path="/report/:runId" element={<Report />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Toasts />
    </Router>
  );
}
