import { create } from 'zustand';

// Helper to get cookie by name
const getCookie = (name) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
};

// Helper to set cookie
const setCookie = (name, value, days = 365) => {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = `expires=${date.toUTCString()}`;
  document.cookie = `${name}=${value};${expires};path=/;SameSite=Strict`;
};

export const useThemeStore = create((set) => ({
  theme: getCookie('theme') || 'light',
  toggleTheme: () =>
    set((state) => {
      const newTheme = state.theme === 'light' ? 'dark' : 'light';
      setCookie('theme', newTheme);
      document.documentElement.setAttribute('data-theme', newTheme);
      return { theme: newTheme };
    }),
  initTheme: () =>
    set((state) => {
      // If we somehow didn't read it from cookie correctly on initial load, use state
      const currentTheme = getCookie('theme') || state.theme;
      if (getCookie('theme') !== currentTheme) {
        setCookie('theme', currentTheme);
      }
      document.documentElement.setAttribute('data-theme', currentTheme);
      return { theme: currentTheme };
    }),
}));
