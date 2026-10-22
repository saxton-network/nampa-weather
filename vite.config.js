import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the build works from any folder or subdomain.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 }
})
