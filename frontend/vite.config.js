import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Migration console API (../backend). 127.0.0.1 avoids IPv4/IPv6 "localhost" mismatches.
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
})
