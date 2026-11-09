import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfAssets } from './pdf-assets.mjs';

const api = 'http://localhost:' + (process.env.PORT || 3000);

// Stamp dist/sw.js with a version derived from the build output and the list of shell files.
function serviceWorker() {
  let outDir;
  return {
    name: 'zboard-sw',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    writeBundle(_, bundle) {
      // What the app needs to start: the entry script, everything it imports up front, and their CSS.
      // Parts loaded on demand (the PDF reader, pdf.js) are cached by the worker the first time they're used.
      const start = new Set();
      const walk = (f) => {
        const c = bundle[f];
        if (!c || start.has(f)) return;
        start.add(f);
        for (const css of c.viteMetadata?.importedCss ?? []) start.add(css);
        for (const i of c.imports ?? []) walk(i);
      };
      for (const [f, c] of Object.entries(bundle)) if (c.type === 'chunk' && c.isEntry) walk(f);
      const shell = [...start]
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => '/' + f)
        .sort();
      // index.html too: the boot intro lives in it, and the worker serves the page from its cache.
      const html = bundle['index.html']?.source ?? '';
      const version = createHash('sha1').update(shell.join('\n')).update(String(html)).digest('hex').slice(0, 12);
      const file = path.join(outDir, 'sw.js');
      const src = fs.readFileSync(file, 'utf8').replace('__ZB_VERSION__', version).replace('/*__ZB_SHELL__*/ []', JSON.stringify(shell));
      fs.writeFileSync(file, src);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker(), pdfAssets()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/files': { target: api, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
