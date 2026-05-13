import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Chunk splitting per caricare solo quello che serve
        manualChunks: {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js'],
        }
      }
    },
    // Aumenta il limite avvisi bundle
    chunkSizeWarningLimit: 1000,
  }
})
