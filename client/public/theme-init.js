// Prevent flash of wrong theme by reading localStorage before React mounts.
// A separate file, not an inline <script>, so the server's CSP (script-src 'self') allows it.
try {
  const stored = JSON.parse(localStorage.getItem('theme-storage'));
  if (stored && stored.state && stored.state.theme) {
    document.documentElement.setAttribute('data-theme', stored.state.theme);
  }
} catch {
  // Unreadable or corrupt storage: keep the default theme from index.html
}
