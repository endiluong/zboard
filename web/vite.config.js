import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
      const shell = Object.keys(bundle)
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
  plugins: [react(), serviceWorker()],
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
