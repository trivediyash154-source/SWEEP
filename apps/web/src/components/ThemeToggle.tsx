import { usePrefs } from '../state/prefs';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  return (
    <div className="segmented theme-toggle" role="group" aria-label="Colour theme">
      <button type="button" aria-pressed={theme === 'velvet'} onClick={() => setTheme('velvet')} title="Velvet — royal night">
        <span className="theme-swatch theme-swatch--velvet" aria-hidden="true" />
        {compact ? <span className="visually-hidden">Velvet</span> : 'Velvet'}
      </button>
      <button type="button" aria-pressed={theme === 'porcelain'} onClick={() => setTheme('porcelain')} title="Porcelain — cream daylight">
        <span className="theme-swatch theme-swatch--porcelain" aria-hidden="true" />
        {compact ? <span className="visually-hidden">Porcelain</span> : 'Porcelain'}
      </button>
    </div>
  );
}
