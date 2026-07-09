import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base so the build works at https://<user>.github.io/advisorapp/
  // (or any subpath) without configuration.
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      // forward API calls to the FastAPI backend during development
      // (only used once the UI grows API-backed features again)
      '/api': 'http://localhost:8000',
    },
  },
})
