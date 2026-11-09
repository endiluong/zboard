// The boot intro in index.html stays up until the app has something real to show: the first board's
// cards, or the sign-in page. It plays for at least MIN_MS so the name has landed and "Loading"
// is showing even on a fast start, and leaves after MAX_MS whatever happens (an error is better
// seen than hidden). Automated browsers (the e2e tests) don't wait for the show.
const MIN_MS = navigator.webdriver ? 0 : 1800;
const MAX_MS = 12000;
let done = false;

export function bootDone() {
  if (done) return;
  done = true;
  const el = document.getElementById('boot');
  if (!el) return;
  const wait = Math.max(0, MIN_MS - performance.now());
  setTimeout(() => {
    el.classList.add('boot-out');
    setTimeout(() => el.remove(), 400);
  }, wait);
}

setTimeout(bootDone, MAX_MS);
