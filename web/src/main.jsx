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
if (import.meta.env.PROD && !DEMO && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
