import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { bootDone } from './boot.js';
import { DEMO } from './demo.js';
import './styles.css';

const root = createRoot(document.getElementById('root'));

if (DEMO) {
  // The online demo's server runs in a service worker in this browser (web/demo/sw.js): start the
  // app once that worker answers this page's requests.
  const boot = async () => {
    if (!('serviceWorker' in navigator)) throw new Error('no service worker');
    const base = import.meta.env.BASE_URL;
    await navigator.serviceWorker.register(`${base}demo-sw.js`, { scope: base });
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  };
  root.render(<div className="splash">ZBoard</div>);
  boot()
    .then(() => root.render(<App />))
    .catch(() => {
      bootDone();
      root.render(
        <div className="splash demo-unsupported">
          <p>The ZBoard demo needs a browser that allows service workers (a private window may not).</p>
        </div>
      );
    });
} else {
  root.render(<App />);
}

// iOS Safari zooms the whole page on a pinch (or a double tap) outside the board, and then the bars
// slide off screen. The board does its own pinch zoom with pointer events, so the page never needs to.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

// The service worker only runs from a build (it needs HTTPS or localhost).
// Updates: the page opens from the worker's saved copy, so a new ZBoard on the server arrives as a
// new worker. A phone app is rarely closed for real (it sleeps in the background), so it would keep
// running the old version for days. So: check for a new version every time the app comes back to
// the front, and reload into it when that is harmless: right after opening or coming back (nothing
// typed yet). Otherwise it waits for the next time the app is brought back. Big uploads carry on
// after the reload (uploads.js).
if (import.meta.env.PROD && !DEMO && 'serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller; // false on the very first visit: nothing old to replace
  let frontAt = Date.now();
  let pending = false;
  const reload = () => {
    if (reload.done) return;
    reload.done = true;
    location.reload();
  };
  sw.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (!document.hidden && Date.now() - frontAt < 10000) reload();
    else pending = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    frontAt = Date.now();
    if (pending) reload();
    else sw.getRegistration().then((r) => r?.update()).catch(() => {});
  });
  window.addEventListener('load', () => {
    frontAt = Date.now();
    sw.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
