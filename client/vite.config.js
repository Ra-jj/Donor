import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        // Libraries the first page needs go in their own chunks. Without this, every chunk imports
        // the entry chunk, so a one-line app change renamed every file and a deploy made returning
        // visitors (and the service worker's precache) download ~265 kB gzip again, not ~30 kB.
        // React + router and the other libraries are two groups, so each stays under Vite's 500 kB
        // warning and a version bump in one leaves the other cached.
        // $initial keeps libraries only lazy pages use (leaflet, parts of motion) in those pages' chunks.
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              tags: ['$initial'],
              priority: 2,
            },
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/]/,
              tags: ['$initial'],
              priority: 1,
            },
          ],
        },
      },
    },
  },
  plugins: [
    react(), 
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Donor - Blood Match',
        short_name: 'Donor',
        description: 'Emergency Blood Donation Matching',
        theme_color: '#EF4444',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      devOptions: {
        enabled: true,
        type: 'module',
      }
    })
  ],
})
