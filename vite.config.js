import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@supabase/supabase-js'],
  }
})
