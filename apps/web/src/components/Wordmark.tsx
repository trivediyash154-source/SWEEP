import { Link } from 'react-router-dom';

/** The SWEEP wordmark: a route glyph plus spectral letterforms. */
export function Wordmark({ size = 'md', to = '/' }: { size?: 'sm' | 'md' | 'lg'; to?: string | null }) {
  const inner = (
    <>
      <svg className="wordmark__glyph" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="wm-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F3A7C4" />
            <stop offset=".5" stopColor="#E9C98C" />
            <stop offset="1" stopColor="#75E0FF" />
          </linearGradient>
        </defs>
        <path d="M5 23 L12 9 L19 20 L27 7" fill="none" stroke="url(#wm-g)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="5" cy="23" r="2.4" fill="#E9C98C" />
        <circle cx="27" cy="7" r="2.4" fill="#F3A7C4" />
      </svg>
      <span className="wordmark__text spectral-text">SWEEP</span>
    </>
  );
  const cls = `wordmark wordmark--${size}`;
  return to ? (
    <Link to={to} className={cls} aria-label="SWEEP home">
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}
