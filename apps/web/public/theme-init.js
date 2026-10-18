// Applies the saved theme before first paint (external file so CSP can forbid inline scripts).
(function () {
  try {
    var saved = localStorage.getItem('sweep.theme');
    var theme = saved === 'velvet' || saved === 'porcelain' ? saved : window.matchMedia('(prefers-color-scheme: light)').matches ? 'porcelain' : 'velvet';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'velvet');
  }
})();
