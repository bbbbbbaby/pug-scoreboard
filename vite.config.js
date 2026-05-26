import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Plugin che inietta la versione nel sw.js ad ogni build
function swVersionPlugin() {
  return {
    name: 'sw-version',
    closeBundle() {
      const swPath = resolve('dist/sw.js')
      try {
        let sw = readFileSync(swPath, 'utf8')
        const version = Date.now().toString(36) // es. "lzxy3k4a"
        sw = sw.replace('__SW_VERSION__', version)
        writeFileSync(swPath, sw)
        console.log(`✅ SW version: ${version}`)
      } catch(e) {
        console.warn('sw-version plugin: sw.js not found in dist', e.message)
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), swVersionPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'supabase': ['@supabase/supabase-js'],
        }
      }
    },
    chunkSizeWarningLimit: 1500,
    minify: 'esbuild',
    target: 'es2020',
    // Copia sw.js da public/ a dist/ senza modificarlo (il plugin lo farà dopo)
    copyPublicDir: true,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@supabase/supabase-js'],
  }
})
