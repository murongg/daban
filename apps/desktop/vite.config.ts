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
      name: 'preview-discussion-redirect',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url || '/', 'http://preview.invalid');
          if (url.pathname !== '/preview/comments.html') return next();
          if (!url.searchParams.has('mode')) url.searchParams.set('mode', 'discussion');
          response.statusCode = 302;
          response.setHeader('Location', `/preview/tasks.html${url.search}`);
          response.end();
        });
      },
    },
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
