import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { solveChinesePostman } from '@sweep/engine';
import { heroCity } from '@sweep/engine/examples';
import { useAuth } from '../state/auth';
import { ApiRequestError } from '../lib/api';
import { Wordmark } from '../components/Wordmark';
import { ThemeToggle } from '../components/ThemeToggle';
import { StaticNetwork } from '../landing/StaticNetwork';
import { toast } from '../state/toasts';
import '../styles/auth.css';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const art = useMemo(() => {
    const g = heroCity();
    const r = solveChinesePostman(g);
    return { g, r: r.ok ? r : null };
  }, []);
  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__top">
          <Wordmark size="sm" />
          <ThemeToggle compact />
        </div>
        <main id="main" className="auth__main">
          <p className="eyebrow">Account</p>
          <h1 className="auth__title">{title}</h1>
          <p className="muted">{subtitle}</p>
          {status === 'unavailable' ? (
            <div className="notice notice--info" role="status">
              Accounts need the SWEEP server, which this build cannot reach. Everything else works in local mode, including saving scenarios on this device.
              <Link to="/workspace" className="btn btn--quiet btn--sm">
                Open the workspace
              </Link>
            </div>
          ) : (
            children
          )}
          <p className="faint small auth__local">
            No account needed to explore: <Link to="/workspace">open the workspace in local mode</Link>.
          </p>
        </main>
      </div>
      <aside className="auth__art" aria-hidden="true">
        <StaticNetwork graph={art.g} result={art.r} overlay="route" assumedWidth={760} label="" />
        <blockquote className="auth__quote">
          <span className="serif">“Every street has a story. Every route has a proof.”</span>
        </blockquote>
      </aside>
    </div>
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return 'Something went wrong. Please try again.';
}

export function SignIn() {
  const signIn = useAuth((s) => s.signIn);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      toast.success('Signed in');
      navigate('/workspace');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Welcome back." subtitle="Sign in to keep scenarios and optimisation runs in your account.">
      <form className="form-stack auth__form" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field__label">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="signin-email" />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="signin-password" />
        </label>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={busy || !email || !password} data-testid="signin-submit">
          {busy ? <span className="spinner" aria-hidden="true" /> : null} Sign in
        </button>
        <p className="small muted">
          New to SWEEP? <Link to="/register">Create an account</Link>
        </p>
        <p className="faint small">Password reset needs an email service, which is not configured in this deployment. Contact the administrator if you are locked out.</p>
      </form>
    </AuthShell>
  );
}

export function Register() {
  const register = useAuth((s) => s.register);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && password.length < 10;
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, password, displayName);
      toast.success('Account created', 'You are signed in.');
      navigate('/workspace');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Create your account." subtitle="Save networks, keep every optimisation run reproducible, and pick up where you left off.">
      <form className="form-stack auth__form" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field__label">Display name</span>
          <input className="input" autoComplete="nickname" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="register-name" />
        </label>
        <label className="field">
          <span className="field__label">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="register-email" />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={password} aria-invalid={tooShort} aria-describedby="pw-hint" onChange={(e) => setPassword(e.target.value)} data-testid="register-password" />
          <span id="pw-hint" className={tooShort ? 'field__error' : 'field__hint'}>
            At least 10 characters. Long passphrases are best.
          </span>
        </label>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={busy || !email || password.length < 10 || !displayName.trim()} data-testid="register-submit">
          {busy ? <span className="spinner" aria-hidden="true" /> : null} Create account
        </button>
        <p className="small muted">
          Already registered? <Link to="/signin">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
