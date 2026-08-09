import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative assets work in both Vite development and GitHub Pages project sites.
  base: './',
  plugins: [react()],
})
