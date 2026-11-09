// Vite plugin for pdf.js (used by vite.config.js and demo/build.mjs).
// - Uses pdf.js's "legacy" build everywhere: react-pdf imports plain 'pdfjs-dist', which is the modern
//   build. That one expects the newest browsers (URL.parse and more): on older iPhones the reader sat
//   on "Opening…" for ever. The worker (src/pdf.js) must be the legacy build too: pdf.js only checks
//   that both halves have the same version number, never that they are the same build. The alias is
//   anchored (^…$) so it only catches the bare name, never a path like the worker's.
// - Guards the build (fails it) if pdf.js ships as the modern build, if the worker isn't the legacy
//   file, or if pdf.js ends up in what the app downloads to start (it must load only with a PDF).
// - Copies the character maps and standard fonts into <outDir>/pdfjs/, where src/pdf.js tells pdf.js
//   to find them. Some PDFs (Asian scripts, files that don't embed the basic fonts) can't be drawn
//   without them. They are fetched only by PDFs that need them.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const pdfjsDir = () => path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const IS_PDFJS = /Setting up fake worker/; // a message only pdf.js's main half contains
const IS_LEGACY = /typeof AbortSignal\.any/; // a fallback only the legacy build carries

export function pdfAssets() {
  let outDir;
  return {
    name: 'zboard-pdf-assets',
    config: () => ({ resolve: { alias: [{ find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' }] } }),
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    generateBundle(_, bundle) {
      const legacyWorker = fs.readFileSync(path.join(pdfjsDir(), 'legacy/build/pdf.worker.min.mjs'));
      const start = new Set();
      const walk = (f) => {
        const c = bundle[f];
        if (!c || c.type !== 'chunk' || start.has(f)) return;
        start.add(f);
        for (const i of c.imports) walk(i);
      };
      for (const [f, c] of Object.entries(bundle)) if (c.type === 'chunk' && c.isEntry) walk(f);
      let main = 0;
      let worker = 0;
      for (const [f, c] of Object.entries(bundle)) {
        if (c.type === 'chunk' && IS_PDFJS.test(c.code)) {
          main++;
          if (!IS_LEGACY.test(c.code)) this.error(`${f} has the modern pdf.js build; it must be the legacy one (see pdf-assets.mjs)`);
          if (start.has(f)) this.error(`${f} puts pdf.js in the app's startup download; it must only load with a PDF`);
        }
        if (c.type === 'asset' && /pdf\.worker/.test(f)) {
          worker++;
          if (!Buffer.from(c.source).equals(legacyWorker)) this.error(`${f} is not the legacy pdf.js worker`);
        }
      }
      if (main && !worker) this.error('pdf.js is bundled but its worker file is missing');
    },
    writeBundle() {
      if (!outDir) return;
      for (const dir of ['cmaps', 'standard_fonts']) fs.cpSync(path.join(pdfjsDir(), dir), path.join(outDir, 'pdfjs', dir), { recursive: true });
    },
  };
}
