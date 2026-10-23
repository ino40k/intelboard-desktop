import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'reader-assets',
      closeBundle() {
        mkdirSync('dist/pdfjs', { recursive: true });
        for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
          cpSync('node_modules/pdfjs-dist/' + folder, 'dist/pdfjs/' + folder, { recursive: true });
      },
    },
  ],
  build: { sourcemap: false },
});
