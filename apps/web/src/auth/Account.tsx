import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../state/auth';
import { api, ApiRequestError } from '../lib/api';
import { SiteNav } from '../components/SiteNav';
import { toast } from '../state/toasts';
import { Dialog } from '../components/Dialog';
import '../styles/auth.css';

export default function Account() {
  const { status, user, setUser, signOut } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'signed-out') navigate('/signin', { replace: true });
  }, [status, navigate]);
  useEffect(() => setName(user?.displayName ?? ''), [user]);

  if (status === 'unavailable') {
    return (
      <div className="page">
        <SiteNav />
        <main id="main" className="page__main">
          <h1>Account</h1>
          <p className="muted">Accounts need the SWEEP server, which this build cannot reach. Scenarios are saved on this device instead.</p>
        </main>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="page">
        <SiteNav />
        <main id="main" className="page__main" role="status">
          Loading account…
        </main>
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error('Request failed', e instanceof ApiRequestError ? e.message : 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <SiteNav />
      <main id="main" className="page__main account">
        <p className="eyebrow">Account</p>
        <h1 className="account__title">{user.displayName}</h1>
        <p className="muted">
          {user.email} · member since {new Date(user.createdAt).toLocaleDateString()}
        </p>

        <section className="account__section" aria-labelledby="profile-h">
          <h2 id="profile-h">Profile</h2>
          <form
            className="account__row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run('name', async () => {
                const d = await api<{ user: typeof user }>('/account', { method: 'PATCH', body: { displayName: name } });
                setUser(d.user);
                toast.success('Display name updated');
              });
            }}
          >
            <label className="field">
              <span className="field__label">Display name</span>
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="btn btn--quiet" type="submit" disabled={busy === 'name' || !name.trim() || name === user.displayName}>
              Save
            </button>
          </form>
        </section>

        <section className="account__section" aria-labelledby="pw-h">
          <h2 id="pw-h">Password</h2>
          <form
            className="account__grid"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run('pw', async () => {
                await api('/account/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
                setCurrent('');
                setNext('');
                toast.success('Password changed', 'Other sessions were signed out.');
              });
            }}
          >
            <label className="field">
              <span className="field__label">Current password</span>
              <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">New password</span>
              <input className="input" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
              <span className="field__hint">At least 10 characters.</span>
            </label>
            <div>
              <button className="btn btn--quiet" type="submit" disabled={busy === 'pw' || !current || next.length < 10}>
                Change password
              </button>
            </div>
          </form>
        </section>

        <section className="account__section" aria-labelledby="session-h">
          <h2 id="session-h">Session</h2>
          <div className="btn-row">
            <Link to="/workspace" className="btn btn--quiet">
              Back to workspace
            </Link>
            <button
              className="btn btn--quiet"
              type="button"
              onClick={() =>
                void run('out', async () => {
                  await signOut();
                  toast.info('Signed out');
                  navigate('/');
                })
              }
              data-testid="signout"
            >
              Sign out
            </button>
          </div>
        </section>

        <section className="account__section account__section--danger" aria-labelledby="danger-h">
          <h2 id="danger-h">Delete account</h2>
          <p className="muted small">This permanently deletes your account, scenarios and stored runs.</p>
          <button className="btn btn--danger" type="button" onClick={() => setDeleteOpen(true)}>
            Delete account…
          </button>
        </section>
      </main>
      {deleteOpen && (
        <Dialog title="Delete your account?" onClose={() => setDeleteOpen(false)}>
          <form
            className="form-stack"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run('del', async () => {
                await api('/account', { method: 'DELETE', body: { password: deletePw } });
                setUser(null);
                toast.info('Account deleted');
                navigate('/');
              });
            }}
          >
            <p className="muted">Enter your password to confirm. This cannot be undone.</p>
            <input className="input" type="password" autoComplete="current-password" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} aria-label="Password" />
            <div className="dialog__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setDeleteOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--danger" disabled={!deletePw || busy === 'del'}>
                Delete permanently
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
