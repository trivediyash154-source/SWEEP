import { Link, NavLink } from 'react-router-dom';
import { Wordmark } from './Wordmark';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from '../state/auth';

export function SiteNav({ overlay = false }: { overlay?: boolean }) {
  const { status, user } = useAuth();
  return (
    <header className={`site-nav${overlay ? ' site-nav--overlay' : ''}`}>
      <Wordmark />
      <nav aria-label="Primary" className="site-nav__links">
        <NavLink to="/workspace">Workspace</NavLink>
        <NavLink to="/mathematics">Mathematics</NavLink>
        <a href="/#credibility" className="hide-sm">
          Method
        </a>
      </nav>
      <div className="site-nav__end">
        <ThemeToggle compact />
        {status === 'signed-in' && user ? (
          <Link to="/account" className="btn btn--quiet btn--sm">
            {user.displayName}
          </Link>
        ) : status === 'signed-out' ? (
          <Link to="/signin" className="btn btn--quiet btn--sm">
            Sign in
          </Link>
        ) : null}
      </div>
    </header>
  );
}
