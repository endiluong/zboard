// Builds the online demo into web/dist-demo (published to GitHub Pages by .github/workflows/pages.yml):
// the normal web app with a demo flag and a base path, plus demo-sw.js, the service worker that runs
// the server's data layer (server/src/db.js) in the browser on SQLite compiled to WebAssembly.
// Usage (from web/): node demo/build.mjs [base]   base defaults to /zboard/ (the Pages address).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfAssets } from '../pdf-assets.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(web, 'dist-demo');
const base = process.argv[2] || '/zboard/';
const demo = (f) => path.join(web, 'demo', f);

// db.js imports node:crypto (for ids) and ./sqlite.js (node:sqlite): swap both for browser versions.
const browserServer = {
  name: 'zboard-demo-swaps',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === 'node:crypto') return demo('crypto.js');
    if (source === './sqlite.js' && importer && /server[\\/]src[\\/]db\.js$/.test(importer)) return demo('sqlite.js');
    return null;
  },
};
// A classic (non-module) service worker has no import.meta.url; it locates files from its own address.
const workerMeta = { name: 'zboard-demo-meta', resolveImportMeta: (prop) => (prop === 'url' ? 'self.location.href' : null) };

export async function buildDemo({ quiet = false } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  const logLevel = quiet ? 'warn' : 'info';

  // 1. The app, served under the base path, flagged as the demo.
  await build({
    root: web,
    base,
    configFile: false,
    logLevel,
    plugins: [react(), pdfAssets()],
    define: { __ZB_DEMO__: 'true' },
    build: { outDir: out, emptyOutDir: true },
  });
  fs.rmSync(path.join(out, 'sw.js'), { force: true }); // the real app's offline cache isn't used here

  // 2. The service worker with the in-browser server.
  await build({
    root: web,
    configFile: false,
    logLevel,
    publicDir: false,
    plugins: [browserServer, workerMeta],
    build: {
      outDir: out,
      emptyOutDir: false,
      lib: { entry: demo('sw.js'), formats: ['iife'], name: 'zboardDemo', fileName: () => 'demo-sw.js' },
      minify: true,
    },
  });
  fs.copyFileSync(path.join(web, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), path.join(out, 'sqlite3.wasm'));

  // 3. Install as an app from the Pages address; no Jekyll processing on Pages.
  const manifest = JSON.parse(fs.readFileSync(path.join(web, 'public/manifest.webmanifest'), 'utf8'));
  Object.assign(manifest, { name: 'ZBoard demo', short_name: 'ZBoard', id: base, start_url: base, scope: base });
  manifest.icons = manifest.icons.map((i) => ({ ...i, src: base + i.src.replace(/^\//, '') }));
  fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

// Same server code, bundled for Node, so demo/test.mjs can check the routes without a browser.
export async function buildBackendForNode(file) {
  await build({
    root: web,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    plugins: [browserServer],
    build: {
      outDir: path.dirname(file),
      emptyOutDir: false,
      lib: { entry: demo('backend.js'), formats: ['es'], fileName: () => path.basename(file) },
      rollupOptions: { external: ['@sqlite.org/sqlite-wasm'] },
      minify: false,
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = await buildDemo();
  console.log('demo built in', dir);
}
