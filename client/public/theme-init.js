// Prevent flash of wrong theme by applying the saved theme before React mounts.
// useThemeStore saves it in the `theme` cookie, so read that same cookie here.
// A separate file, not an inline <script>, so the server's CSP (script-src 'self') allows it.
try {
  const match = document.cookie.match(/(?:^|;\s*)theme=(light|dark)(?:;|$)/);
  if (match) {
    document.documentElement.setAttribute('data-theme', match[1]);
  }
} catch {
  // Unreadable cookies: keep the default theme from index.html
}
