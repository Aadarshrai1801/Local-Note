import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // Relative base so the built bundle loads correctly from file:// inside Electron.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        // The Hub (main window) and the floating capture bar are separate
        // documents, so the overlay loads only the small bundle it needs.
        hub: fileURLToPath(new URL('./index.html', import.meta.url)),
        capture: fileURLToPath(new URL('./capture.html', import.meta.url))
      }
    }
  },
  server: {
    port: 5273,
    strictPort: true,
    watch: {
      // Without this, Vite watches build output and packaging directories and
      // reloads the page for every extracted file. Only source should trigger a
      // reload.
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
        '**/.venv/**',
        '**/.localnote-data/**',
        '**/.electron-builder-cache/**',
        '**/.electron-cache/**',
        '**/native/bin/**'
      ]
    }
  }
})
