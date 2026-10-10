import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // opencascade.js es un bundle de Emscripten enorme: que Vite no intente
  // pre-optimizarlo ni analizarlo.
  optimizeDeps: { exclude: ['opencascade.js'] },
  server: { fs: { allow: ['..'] } },
});
