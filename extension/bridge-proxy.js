// Claude Annotator — isolated-world bridge proxy.
//
// The main content script (annotator.js) reads React fibers, so it must run in
// world MAIN — but that means its own fetch() calls are governed by the PAGE's
// Content Security Policy. Any app that sets a `connect-src` (or `default-src`)
// CSP therefore blocks every request to the bridge, which lives on a different
// origin (http://localhost:<port>). The visible symptom is that the status dot
// never turns green and "Send" silently fails.
//
// This tiny companion runs in the ISOLATED world, which is governed by the
// EXTENSION's CSP + host permissions instead of the page's, so it can always
// reach the local bridge. annotator.js relays every bridge call here over
// window.postMessage and gets the response back the same way.
(() => {
  // Only ever touch the local bridge — never let arbitrary page script use this
  // as an open fetch relay.
  const OK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/;

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__annotatorBridge !== 'request' || typeof msg.id !== 'number') return;

    const reply = (extra) =>
      window.postMessage({ __annotatorBridge: 'response', id: msg.id, ...extra }, '*');

    if (typeof msg.url !== 'string' || !OK_ORIGIN.test(msg.url)) {
      reply({ netError: 'blocked non-local bridge url' });
      return;
    }
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'GET',
        headers: msg.headers || undefined,
        body: msg.body != null ? msg.body : undefined,
      });
      const text = await res.text();
      reply({ ok: res.ok, status: res.status, text });
    } catch (err) {
      reply({ netError: String((err && err.message) || err) });
    }
  });
})();
