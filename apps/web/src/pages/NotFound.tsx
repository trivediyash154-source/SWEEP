import { Link } from 'react-router-dom';
import { SiteNav } from '../components/SiteNav';

export default function NotFound() {
  return (
    <div className="page">
      <SiteNav />
      <main id="main" className="page__main not-found">
        <p className="eyebrow">404 · dead end</p>
        <h1>This street does not exist.</h1>
        <p className="muted">Even an optimal route cannot reach a page that is not on the map.</p>
        <div className="btn-row">
          <Link className="btn btn--primary" to="/">
            Back to the city
          </Link>
          <Link className="btn btn--quiet" to="/workspace">
            Open the workspace
          </Link>
        </div>
      </main>
    </div>
  );
}
