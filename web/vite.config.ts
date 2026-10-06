import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Stringline is served from `kevinoue.com/stringline/` today and will move to its
 * own domain later. `base` is set from an env var so that move is a build
 * flag, not a hunt for hardcoded paths.
 */
export default defineConfig({
  base: process.env.VITE_BASE ?? '/stringline/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Dev only. In production Caddy does this.
      '/stringline/api': { target: 'http://localhost:3006', changeOrigin: true },
    },
  },
})
