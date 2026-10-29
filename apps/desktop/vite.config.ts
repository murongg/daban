import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true },
  plugins: [
    react(),
    {
      name: 'desktop-content-policy',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          '<head>',
          `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'">`,
        );
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
