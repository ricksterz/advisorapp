import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // forward API calls to the FastAPI backend during development
      '/api': 'http://localhost:8000',
    },
  },
})
