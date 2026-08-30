import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useThemeStore = create(
  persist(
    (set) => ({
      theme: 'light',
      toggleTheme: () =>
        set((state) => {
          const newTheme = state.theme === 'light' ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', newTheme);
          return { theme: newTheme };
        }),
      initTheme: () =>
        set((state) => {
          document.documentElement.setAttribute('data-theme', state.theme);
          return state;
        }),
    }),
    {
      name: 'theme-storage',
    }
  )
);
