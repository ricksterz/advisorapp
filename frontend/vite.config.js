import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Absolute base so history-API routes (/firm/:crd) resolve assets and
  // firms.json correctly from nested paths. Root-relative by default
  // (Cloudflare Workers, local dev); the GitHub Pages workflow sets
  // BASE_PATH=/advisorapp/ for the subpath deploy.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    proxy: {
      // forward API calls to the FastAPI backend during development
      // (only used once the UI grows API-backed features again)
      '/api': 'http://localhost:8000',
    },
  },
})
