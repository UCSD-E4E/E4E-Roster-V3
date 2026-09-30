(() => {
  const storageKey = 'e4e-roster-theme';
  const root = document.documentElement;

  function setTheme(theme) {
    root.dataset.theme = theme;
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      const next = theme === 'dark' ? 'Light mode' : 'Dark mode';
      toggle.textContent = next;
      toggle.setAttribute('aria-label', `Switch to ${next.toLowerCase()}`);
    }
  }

  try {
    setTheme(localStorage.getItem(storageKey) || 'dark');
  } catch {
    setTheme('dark');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      setTheme(next);
      try { localStorage.setItem(storageKey, next); } catch { /* session-only preference */ }
    });
  });
})();
