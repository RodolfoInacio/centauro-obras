import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Site multi-arquivo para hospedagem (GitHub Pages). Os desenhos agora vêm do
// Supabase Storage, então não precisamos mais embutir tudo num único HTML.
export default defineConfig({
  plugins: [react()],
  base: './',
})
