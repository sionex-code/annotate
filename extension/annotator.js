// Claude Annotator — main-world content script.
// Lets the user pick elements, attach change requests, and send them (with the
// exact React component chain + source locations) to whichever coding agent
// is selected in the toolbar, via the local bridge.
(() => {
  if (window.__claudeAnnotator) return;
  window.__claudeAnnotator = true;

  const PORT = window.__CLAUDE_ANNOTATOR_PORT || 4747;
  const BRIDGE = `http://localhost:${PORT}`;

  // ---------------------------------------------------------------- bridge I/O
  //
  // This script runs in world MAIN (it has to, to read React fibers), so its
  // own fetch() calls are subject to the PAGE's Content Security Policy — any
  // app with a `connect-src`/`default-src` CSP blocks every request to the
  // bridge (a different origin) and the status dot would never go green. So all
  // bridge traffic is relayed to the isolated-world companion (bridge-proxy.js),
  // which is governed by the extension's CSP + host permissions instead. If the
  // proxy ever fails to answer (e.g. a page with no CSP, or the companion not
  // yet loaded), we fall back to a direct fetch.

  const bridgeRpc = new Map();
  let bridgeRpcSeq = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__annotatorBridge !== 'response' || !bridgeRpc.has(d.id)) return;
    const { resolve } = bridgeRpc.get(d.id);
    bridgeRpc.delete(d.id);
    resolve(d);
  });

  function proxyRequest(url, options) {
    return new Promise((resolve) => {
      const id = ++bridgeRpcSeq;
      bridgeRpc.set(id, { resolve });
      window.postMessage(
        {
          __annotatorBridge: 'request',
          id,
          url,
          method: options?.method,
          headers: options?.headers,
          body: options?.body,
        },
        '*'
      );
      setTimeout(() => {
        if (bridgeRpc.has(id)) {
          bridgeRpc.delete(id);
          resolve({ timeout: true });
        }
      }, 15000);
    });
  }

  // fetch() replacement for bridge calls. Returns a minimal Response-like object
  // ({ ok, status, json(), text() }); throws on network failure so callers'
  // existing catch-blocks (which drop the green dot) keep working unchanged.
  async function bridgeFetch(path, options = {}) {
    const url = `${BRIDGE}${path}`;
    const r = await proxyRequest(url, options);
    if (!r.timeout && !r.netError) {
      return {
        ok: r.ok,
        status: r.status,
        json: async () => JSON.parse(r.text || 'null'),
        text: async () => r.text || '',
      };
    }
    // Proxy unavailable (no CSP-restricted page, or companion not ready) — a
    // direct fetch works when the page CSP allows it, and throws when it does
    // not (which the caller already handles the same as any bridge outage).
    return fetch(url, options);
  }

  const state = {
    inspecting: false,
    annotations: [], // { id, prompt, el, ...captured info }
    nextId: 1,
    hoverEl: null,
    peers: [], // other on-page instances of the hovered element (same JSX)
    formEl: null, // element currently being annotated
    formPeers: 1, // instance count for the element in the open form
    formImage: null, // data URL of an image pasted into the open form
    screenshots: false, // 📷 toggle: attach pasted images + a page screenshot
    pinLoop: false,
  };

  // ---------------------------------------------------------------- React fibers
  //
  // Strategy: walk the _debugOwner chain (fiber on the client, plain
  // ReactComponentInfo objects for server components) — it yields only the
  // app's own components, no router internals. Source locations come from:
  //  - fiber._debugSource (React <= 18 with webpack) — direct file:line, or
  //  - _debugStack / debugStack fake stacks (React 19) — compiled-chunk frames
  //    that the launcher resolves to original files via sourcemaps.

  function getFiber(el) {
    let node = el;
    while (node) {
      for (const k in node) {
        if (k.startsWith('__reactFiber$')) return node[k];
      }
      node = node.parentElement;
    }
    return null;
  }

  function fiberName(f) {
    const t = f.type;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (t && typeof t === 'object') {
      if (t.displayName) return t.displayName;
      if (typeof t.render === 'function') return t.render.displayName || t.render.name || 'ForwardRef';
      if (t.type) return t.type.displayName || t.type.name || 'Memo';
    }
    return null;
  }

  const isFiber = (node) => node.tag !== undefined && node.return !== undefined;
  const ownerOf = (node) => (node._debugOwner !== undefined ? node._debugOwner : node.owner);

  function nodeName(node) {
    if (isFiber(node)) return fiberName(node);
    return typeof node.name === 'string' ? node.name : null;
  }

  const SRC_RE = /(?:^|[/\\(])((?:src|app|pages|components|lib|features)[/\\][^\s):?#]+\.(?:tsx|ts|jsx|js|mjs|cjs|vue|svelte))/;

  // React <= 18: _debugSource holds the exact JSX location.
  function legacySource(node) {
    const s = node._debugSource;
    if (!s || !s.fileName) return null;
    const file = String(s.fileName).replace(/\\/g, '/');
    const m = file.match(SRC_RE);
    const short = m ? m[1].replace(/\\/g, '/') : file;
    return s.lineNumber ? `${short}:${s.lineNumber}` : short;
  }

  const FRAME_RE = /^\s*at\s+(?:Object\.|exports\.)?([\w$.<>[\]]+)\s+\((.+?):(\d+):(\d+)\)\s*$/;
  const SKIP_FN = /^(fakeJSXCallSite|react_stack_bottom_frame|initializeFakeStack|initializeDebugInfo|initializeElement|reviveModel|jsx|jsxs|jsxDEV|createElement|cloneElement)$/;
  const SKIP_URL = /node_modules|react-server-dom|react-dom[._-]|\/chunks\/node_modules_/;

  function debugStackOf(node) {
    const s = node._debugStack || node.debugStack;
    if (!s) return null;
    return typeof s === 'string' ? s : s.stack || null;
  }

  // First app-level frame of a node's creation stack = where its JSX lives
  // (inside the owner component's file, in compiled coordinates).
  function creationFrame(node) {
    const stack = debugStackOf(node);
    if (!stack) return null;
    for (const line of stack.split('\n')) {
      const m = line.match(FRAME_RE);
      if (!m) continue;
      const [, fn, url, ln, col] = m;
      if (SKIP_FN.test(fn) || SKIP_URL.test(url)) continue;
      return { fn, url, line: +ln, col: +col };
    }
    return null;
  }

  function componentInfo(el) {
    const chain = [];
    const hostFiber = getFiber(el);
    if (!hostFiber) return { chain, jsxFrame: null, jsxSource: null };
    const jsxFrame = creationFrame(hostFiber);
    const jsxSource = legacySource(hostFiber);
    let node = ownerOf(hostFiber);
    let guard = 0;
    while (node && guard++ < 15 && chain.length < 8) {
      const name = nodeName(node);
      if (name && !/^(Fragment|Suspense|Profiler|StrictMode)$/.test(name)) {
        chain.push({
          name,
          source: legacySource(node), // launcher fills via sourcemaps when null
          frame: creationFrame(node),
        });
      }
      node = ownerOf(node);
    }
    return { chain, jsxFrame, jsxSource };
  }

  function nearestComponentName(el) {
    const { chain } = componentInfo(el);
    return chain.length ? chain[0].name : null;
  }

  // ---------------------------------------------------------------- DOM helpers

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${sel}#${node.id}`);
        break;
      }
      const testId = node.getAttribute('data-testid');
      if (testId) {
        parts.unshift(`[data-testid="${testId}"]`);
        break;
      }
      const cls = [...node.classList].filter((c) => !/[[\]:/%.]/.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------- UI (shadow DOM)

  const host = document.createElement('div');
  host.id = 'claude-annotator-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
  #toolbar {
    position: fixed; bottom: 16px; right: 16px; display: flex; align-items: center; gap: 8px;
    background: #1c1b22; color: #e8e6f0; border: 1px solid #3a3844; border-radius: 12px;
    padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); font-size: 13px;
  }
  #toolbar button {
    background: #2a2833; color: #e8e6f0; border: 1px solid #3a3844; border-radius: 8px;
    padding: 6px 10px; font-size: 13px; cursor: pointer;
  }
  #toolbar button:hover { background: #35323f; }
  #toolbar[hidden] { display: none; }
  /* When dragged, the toolbar is positioned by explicit left/top instead of
     the default bottom/right anchor. */
  #toolbar.moved { right: auto; bottom: auto; }
  #toolbar.dragging { user-select: none; cursor: grabbing; }
  #btn-move {
    display: flex; align-items: center; align-self: stretch; cursor: grab;
    color: #6e6980; font-size: 15px; line-height: 1; padding: 0 2px 0 0;
    touch-action: none;
  }
  #btn-move:hover { color: #b3a8ff; }
  #toolbar.dragging #btn-move { cursor: grabbing; }
  #btn-hide { padding: 6px 8px; color: #9d98ad; }
  #btn-inspect.active, #btn-shot.active { background: #6d5ef2; border-color: #6d5ef2; color: #fff; }
  #fab {
    position: fixed; bottom: 16px; right: 16px; width: 38px; height: 38px;
    background: #1c1b22; color: #b3a8ff; border: 1px solid #3a3844; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    font-size: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: .55;
  }
  #fab:hover { opacity: 1; background: #2a2833; }
  #fab[hidden] { display: none; }
  #fab-badge {
    position: absolute; top: -5px; right: -5px; background: #6d5ef2; color: #fff;
    border-radius: 999px; font-size: 10px; font-weight: 700; padding: 1px 5px;
  }
  #fab-badge[hidden] { display: none; }
  #btn-send { background: #6d5ef2; border-color: #6d5ef2; color: #fff; font-weight: 600; }
  #btn-send:hover { background: #5b4cf0; }
  #agent-select {
    background: #2a2833; color: #e8e6f0; border: 1px solid #3a3844; border-radius: 8px;
    padding: 5px 6px; font-size: 12px; cursor: pointer; max-width: 110px;
  }
  #agent-select:hover { background: #35323f; }
  #count {
    min-width: 22px; text-align: center; background: #35323f; border-radius: 999px;
    padding: 3px 7px; font-weight: 700; font-size: 12px;
  }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
  #dot.on { background: #3ecf6f; }
  #hover-box {
    position: fixed; pointer-events: none; border: 2px solid #6d5ef2;
    background: rgba(109,94,242,.12); border-radius: 4px;
  }
  /* Secondary outlines for the other instances of the same component/JSX line,
     so you can see everything a change would affect. Lighter + dashed so the
     element actually under the cursor (#hover-box) still reads as primary. */
  .peer-box {
    position: fixed; pointer-events: none; border: 1.5px dashed #8b7ff5;
    background: rgba(109,94,242,.06); border-radius: 4px;
  }
  #hover-label {
    position: absolute; top: -24px; left: -2px; white-space: nowrap;
    background: #6d5ef2; color: #fff; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 4px;
  }
  .pin {
    position: fixed; top: 0; left: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
    background: #f2545b; color: #fff; border-radius: 50%; border: 2px solid #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 800; pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,.4);
  }
  #form {
    position: fixed; width: 320px; background: #1c1b22; color: #e8e6f0;
    border: 1px solid #3a3844; border-radius: 12px; padding: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  #form-target { font-size: 11px; color: #9d98ad; margin-bottom: 8px; word-break: break-all; }
  #form-target b { color: #b3a8ff; }
  #form textarea {
    width: 100%; min-height: 72px; resize: vertical; background: #14131a; color: #e8e6f0;
    border: 1px solid #3a3844; border-radius: 8px; padding: 8px; font-size: 13px;
  }
  #form-image {
    display: flex; align-items: center; gap: 8px; margin-top: 8px;
    font-size: 12px; color: #b3a8ff;
  }
  #form-image[hidden] { display: none; }
  #form-image img { max-height: 48px; max-width: 120px; border-radius: 6px; border: 1px solid #3a3844; }
  #form-image button { background: none; border: none; color: #9d98ad; cursor: pointer; font-size: 13px; padding: 0 2px; }
  #form-image button:hover { color: #e8e6f0; }
  #form-actions { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
  #form-actions button { border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; border: 1px solid #3a3844; }
  #form-save { background: #6d5ef2; border-color: #6d5ef2 !important; color: #fff; font-weight: 600; }
  #form-cancel { background: #2a2833; color: #e8e6f0; }
  #toast {
    position: fixed; bottom: 70px; right: 16px; max-width: 360px;
    background: #14131a; color: #e8e6f0; border: 1px solid #6d5ef2; border-radius: 10px;
    padding: 10px 14px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  #results {
    position: fixed; bottom: 70px; right: 16px; width: 340px; max-height: 55vh;
    display: flex; flex-direction: column; overflow: hidden;
    background: #1c1b22; color: #e8e6f0; border: 1px solid #3a3844; border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 13px;
  }
  #results[hidden] { display: none; }
  #results-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid #3a3844; font-weight: 700;
  }
  #results-head span { color: #3ecf6f; }
  #results-close { background: none; border: none; color: #9d98ad; cursor: pointer; font-size: 14px; padding: 0 2px; }
  #results-close:hover { color: #e8e6f0; }
  #results-list { overflow-y: auto; padding: 4px 12px 10px; }
  .result-batch { border-bottom: 1px dashed #3a3844; padding: 8px 0; }
  .result-batch:last-child { border-bottom: none; }
  .result-time { color: #9d98ad; font-size: 10px; margin-bottom: 4px; }
  .result-msg { color: #b3a8ff; margin-bottom: 4px; }
  .result-item { display: flex; gap: 8px; margin: 6px 0; align-items: flex-start; }
  .result-item .st { flex: none; font-weight: 800; }
  .st.done { color: #3ecf6f; }
  .st.failed { color: #f2545b; }
  .st.skipped { color: #e6b450; }
  .result-item .files { color: #9d98ad; font-size: 11px; margin-top: 2px; word-break: break-all; }
  .result-agent { color: #b3a8ff; font-weight: 600; }
  .result-model { color: #9d98ad; font-weight: 400; }
  #settings {
    position: fixed; bottom: 70px; right: 16px; width: 340px; max-height: 60vh;
    display: flex; flex-direction: column; overflow: hidden;
    background: #1c1b22; color: #e8e6f0; border: 1px solid #3a3844; border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 13px;
  }
  #settings[hidden] { display: none; }
  #settings-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid #3a3844; font-weight: 700;
  }
  #settings-close { background: none; border: none; color: #9d98ad; cursor: pointer; font-size: 14px; padding: 0 2px; }
  #settings-close:hover { color: #e8e6f0; }
  #settings-list { overflow-y: auto; padding: 8px 12px; }
  #settings-hint { color: #9d98ad; font-size: 11px; margin-bottom: 8px; }
  .prompt-row { margin-bottom: 10px; }
  .prompt-row label { display: block; color: #b3a8ff; font-weight: 600; font-size: 12px; margin-bottom: 4px; }
  .prompt-row textarea {
    width: 100%; min-height: 44px; resize: vertical; background: #14131a; color: #e8e6f0;
    border: 1px solid #3a3844; border-radius: 8px; padding: 6px 8px; font-size: 12px;
  }
  #settings-actions { display: flex; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid #3a3844; }
  #settings-save {
    background: #6d5ef2; border: 1px solid #6d5ef2; color: #fff; font-weight: 600;
    border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
</style>
<div id="toolbar">
  <span id="btn-move" title="Drag to move the toolbar">&#10303;</span>
  <span id="dot" title="Claude bridge status"></span>
  <button id="btn-inspect" title="Toggle annotate mode (Esc exits)">&#10021; Annotate</button>
  <button id="btn-shot" title="Page screenshot: when ON, sending also attaches a full-page screenshot of the app (reference images you paste into a note are always sent, independent of this)">&#128247;</button>
  <span id="count">0</span>
  <select id="agent-select" title="Choose which agent to send to"></select>
  <button id="btn-send">Send &#10148;</button>
  <button id="btn-results-toggle" title="Show recently applied changes (per batch: agent + model)">&#10003;</button>
  <button id="btn-settings" title="Per-agent settings: standing instructions sent with every batch">&#9881;</button>
  <button id="btn-clear" title="Clear all annotations">&#10005;</button>
  <button id="btn-hide" title="Hide toolbar (Alt+Shift+A)">&#8722;</button>
</div>
<button id="fab" hidden title="Claude Annotator (Alt+Shift+A)">&#10021;<span id="fab-badge" hidden>0</span></button>
<div id="hover-box" hidden><span id="hover-label"></span></div>
<div id="peers"></div>
<div id="pins"></div>
<div id="form" hidden>
  <div id="form-target"></div>
  <textarea id="form-text" placeholder="What should Claude change here? (Ctrl+Enter to save · paste an image to attach a reference)"></textarea>
  <div id="form-image" hidden><img alt="reference image" /><span>reference image attached</span><button id="form-image-remove" title="Remove reference image">&#10005;</button></div>
  <div id="form-actions">
    <button id="form-cancel">Cancel</button>
    <button id="form-save">Save</button>
  </div>
</div>
<div id="results" hidden>
  <div id="results-head"><span>&#10003; Changes applied</span><button id="results-close" title="Close">&#10005;</button></div>
  <div id="results-list"></div>
</div>
<div id="settings" hidden>
  <div id="settings-head">&#9881; Per-agent instructions<button id="settings-close" title="Close">&#10005;</button></div>
  <div id="settings-list">
    <div id="settings-hint">Standing instructions attached to every batch you send to that agent (its <code>agentPrompt</code>). Saved on this machine for all projects.</div>
  </div>
  <div id="settings-actions"><button id="settings-save">Save</button></div>
</div>
<div id="toast" hidden></div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => shadow.getElementById(id);
  const ui = {
    toolbar: $('toolbar'), move: $('btn-move'), hide: $('btn-hide'), fab: $('fab'), fabBadge: $('fab-badge'),
    inspect: $('btn-inspect'), send: $('btn-send'), clear: $('btn-clear'), agentSelect: $('agent-select'),
    shot: $('btn-shot'),
    count: $('count'), dot: $('dot'), hoverBox: $('hover-box'), hoverLabel: $('hover-label'),
    pins: $('pins'), peers: $('peers'), form: $('form'), formTarget: $('form-target'),
    formText: $('form-text'), formSave: $('form-save'), formCancel: $('form-cancel'),
    formImage: $('form-image'), formImageRemove: $('form-image-remove'),
    toast: $('toast'), results: $('results'), resultsList: $('results-list'),
    resultsClose: $('results-close'), resultsToggle: $('btn-results-toggle'),
    settings: $('settings'), settingsList: $('settings-list'), settingsHint: $('settings-hint'),
    settingsOpen: $('btn-settings'), settingsClose: $('settings-close'), settingsSave: $('settings-save'),
  };

  let toastTimer;
  function toast(msg, ms = 3500) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), ms);
  }

  function updateCount() {
    const n = state.annotations.length;
    ui.count.textContent = String(n);
    ui.fabBadge.textContent = String(n);
    ui.fabBadge.hidden = n === 0;
  }

  // ------------------------------------------------------------ hide / show

  const HIDDEN_KEY = 'claude-annotator-hidden';

  function setToolbarHidden(hidden) {
    if (hidden) {
      setInspecting(false);
      closeForm();
      ui.settings.hidden = true;
    }
    ui.toolbar.hidden = hidden;
    ui.fab.hidden = !hidden;
    try {
      localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '');
    } catch {}
    if (!hidden) {
      restoreToolbarPos();
      pingBridge();
    }
  }

  // ------------------------------------------------------------ drag / move
  //
  // The toolbar defaults to the bottom-right corner; the user can drag it
  // anywhere by the ⠿ grip. Position is stored per-port and re-clamped to the
  // viewport on load and resize so it never ends up off-screen.

  const POS_KEY = `claude-annotator-pos-${PORT}`;

  function clampPos(x, y) {
    const r = ui.toolbar.getBoundingClientRect();
    const maxX = Math.max(0, innerWidth - r.width);
    const maxY = Math.max(0, innerHeight - r.height);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }

  function applyToolbarPos(x, y) {
    ui.toolbar.classList.add('moved');
    ui.toolbar.style.left = `${x}px`;
    ui.toolbar.style.top = `${y}px`;
  }

  function restoreToolbarPos() {
    let p = null;
    try {
      p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch {}
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const c = clampPos(p.x, p.y);
    applyToolbarPos(c.x, c.y);
  }

  let drag = null;
  ui.move.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = ui.toolbar.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    ui.toolbar.classList.add('dragging');
    ui.move.setPointerCapture(e.pointerId);
  });
  ui.move.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = clampPos(e.clientX - drag.dx, e.clientY - drag.dy);
    applyToolbarPos(c.x, c.y);
  });
  function endDrag(e) {
    if (!drag) return;
    drag = null;
    ui.toolbar.classList.remove('dragging');
    try {
      ui.move.releasePointerCapture(e.pointerId);
    } catch {}
    const r = ui.toolbar.getBoundingClientRect();
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
    } catch {}
  }
  ui.move.addEventListener('pointerup', endDrag);
  ui.move.addEventListener('pointercancel', endDrag);

  addEventListener('resize', () => {
    if (!ui.toolbar.classList.contains('moved') || ui.toolbar.hidden) return;
    const r = ui.toolbar.getBoundingClientRect();
    const c = clampPos(r.left, r.top);
    applyToolbarPos(c.x, c.y);
  });

  // ---------------------------------------------------------------- pins

  const pinEls = new Map();

  function addPin(a) {
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = String(a.id);
    ui.pins.appendChild(pin);
    pinEls.set(a.id, pin);
    if (!state.pinLoop) {
      state.pinLoop = true;
      requestAnimationFrame(layoutPins);
    }
  }

  function layoutPins() {
    if (!state.annotations.length) {
      state.pinLoop = false;
      return;
    }
    for (const a of state.annotations) {
      const pin = pinEls.get(a.id);
      if (!pin) continue;
      if (a.el && a.el.isConnected) {
        const r = a.el.getBoundingClientRect();
        pin.style.transform = `translate(${r.left + 4}px, ${r.top + 4}px)`;
        pin.style.opacity = '1';
      } else {
        pin.style.opacity = '0.35';
      }
    }
    requestAnimationFrame(layoutPins);
  }

  function clearAll() {
    state.annotations = [];
    state.nextId = 1; // renumber from #1 for the next batch, not a running total
    pinEls.forEach((p) => p.remove());
    pinEls.clear();
    updateCount();
  }

  // ---------------------------------------------------------------- inspect mode

  function setInspecting(on) {
    state.inspecting = on;
    ui.inspect.classList.toggle('active', on);
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) {
      ui.hoverBox.hidden = true;
      hidePeers();
    }
  }

  function onHost(e) {
    return e.composedPath().includes(host);
  }

  // ------------------------------------------------ repeated-instance highlight
  //
  // A card/row rendered by `.map()` appears many times, but every instance
  // comes from the SAME component + JSX line — so editing one edits them all.
  // On hover we find those sibling instances and outline each, making that
  // blast radius visible. "Same" is decided by React creation site (the JSX
  // file:line, identical across instances) when available, falling back to a
  // DOM class/sibling match on pages without React debug info.

  const PEER_CAP = 100; // don't outline more than this many at once

  // Stable identity for "which JSX created this element": the sourcemap-ready
  // creation frame (or React<=18 _debugSource). Identical for every instance
  // of a mapped component; null when there's no React fiber.
  function creationSig(el) {
    const f = getFiber(el);
    if (!f) return null;
    const legacy = legacySource(f);
    if (legacy) return 'L:' + legacy;
    const fr = creationFrame(f);
    if (fr) return `F:${fr.url}:${fr.line}:${fr.col}`;
    return null;
  }

  // Classes safe to put in a selector (drop Tailwind's :/[]/. variants etc.).
  function safeClasses(el) {
    return [...el.classList].filter((c) => !/[[\]:/%.@#!()]/.test(c));
  }

  function classSelector(el) {
    const tag = el.tagName.toLowerCase();
    const cls = safeClasses(el);
    return cls.length ? tag + '.' + cls.map((c) => CSS.escape(c)).join('.') : tag;
  }

  // Candidate elements that might be instances of the same thing: class-selector
  // matches across the page (catches nested children shared between cards) UNION
  // same-tag DOM siblings (catches mapped rows whose per-item classes differ).
  function gatherCandidates(el) {
    const set = new Set();
    try {
      let n = 0;
      for (const c of document.querySelectorAll(classSelector(el))) {
        set.add(c);
        if (++n >= 400) break;
      }
    } catch {}
    const parent = el.parentElement;
    if (parent) {
      for (const c of parent.children) if (c.tagName === el.tagName) set.add(c);
    }
    return set;
  }

  // The set of elements that are "the same" as `el` (always includes `el`).
  function findPeers(el) {
    const sig = creationSig(el);
    const cands = gatherCandidates(el);
    const peers = [];
    if (sig) {
      for (const c of cands) {
        if (c === host || host.contains(c)) continue;
        if (c === el || creationSig(c) === sig) peers.push(c);
        if (peers.length >= PEER_CAP) break;
      }
    } else if (safeClasses(el).length) {
      // No React signal — trust a specific class selector only (never bare-tag
      // soup like every <div>), and require same tag.
      for (const c of cands) {
        if (c === host || host.contains(c) || c.tagName !== el.tagName) continue;
        peers.push(c);
        if (peers.length >= PEER_CAP) break;
      }
    }
    if (!peers.includes(el)) peers.unshift(el);
    return peers;
  }

  // Pooled outline boxes for every peer except the one under the cursor (that
  // one is the solid #hover-box). Repositioned each mousemove so they track
  // scrolling without re-querying the page.
  const peerBoxPool = [];
  function drawPeerBoxes() {
    let i = 0;
    for (const p of state.peers || []) {
      if (p === state.hoverEl || !p.isConnected) continue;
      const r = p.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      let box = peerBoxPool[i];
      if (!box) {
        box = document.createElement('div');
        box.className = 'peer-box';
        ui.peers.appendChild(box);
        peerBoxPool[i] = box;
      }
      box.hidden = false;
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      i++;
    }
    for (let j = i; j < peerBoxPool.length; j++) peerBoxPool[j].hidden = true;
  }
  function hidePeers() {
    state.peers = [];
    for (const b of peerBoxPool) b.hidden = true;
  }

  function onMove(e) {
    if (!state.inspecting || onHost(e)) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const changed = el !== state.hoverEl;
    state.hoverEl = el;
    const r = el.getBoundingClientRect();
    ui.hoverBox.hidden = false;
    ui.hoverBox.style.left = r.left + 'px';
    ui.hoverBox.style.top = r.top + 'px';
    ui.hoverBox.style.width = r.width + 'px';
    ui.hoverBox.style.height = r.height + 'px';
    // Recompute the (heavier) component name + peer set only when the target
    // element actually changes; just reposition the boxes on plain moves.
    if (changed) {
      state.peers = findPeers(el);
      const name = nearestComponentName(el) || el.tagName.toLowerCase();
      const n = state.peers.length;
      ui.hoverLabel.textContent = n > 1 ? `${name} ×${n}` : name;
    }
    drawPeerBoxes();
  }

  // Human-friendly description of an element for the annotation form — the
  // component name plus a text snippet, never raw HTML/selectors/file paths
  // (those still go to Claude in the payload, they just aren't shown here).
  function friendlyLabel(el, chain) {
    const top = chain && chain[0];
    const name = top ? top.name : el.tagName.toLowerCase();
    const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    return { name, text };
  }

  function openForm(el) {
    state.formEl = el;
    state.formPeers = findPeers(el).length;
    const { chain } = componentInfo(el);
    const { name, text } = friendlyLabel(el, chain);
    ui.formTarget.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = name;
    ui.formTarget.appendChild(b);
    if (text) ui.formTarget.appendChild(document.createTextNode(` — “${text}”`));
    if (state.formPeers > 1)
      ui.formTarget.appendChild(document.createTextNode(` · ${state.formPeers}× on this page`));
    ui.formText.value = '';
    setFormImage(null);
    ui.form.hidden = false;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left), innerWidth - 336);
    const y = Math.min(Math.max(8, r.bottom + 8), innerHeight - 190);
    ui.form.style.left = x + 'px';
    ui.form.style.top = y + 'px';
    ui.formText.focus();
  }

  function closeForm() {
    ui.form.hidden = true;
    state.formEl = null;
    setFormImage(null);
  }

  // ------------------------------------------------------ pasted screenshots

  function setFormImage(dataUrl) {
    state.formImage = dataUrl;
    ui.formImage.hidden = !dataUrl;
    ui.formImage.querySelector('img').src = dataUrl || '';
  }

  // Ctrl+V an image (e.g. a design mockup or an external screenshot) into the
  // note textarea — it is attached to this annotation as a *reference image*
  // and saved to a file by the bridge, which replaces it with an `imagePath`
  // the agent can open. This is independent of the 📷 page-screenshot toggle:
  // a pasted reference is always sent.
  ui.formText.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setFormImage(reader.result);
    reader.readAsDataURL(file);
  });
  ui.formImageRemove.addEventListener('click', () => setFormImage(null));

  function saveAnnotation() {
    const el = state.formEl;
    const prompt = ui.formText.value.trim();
    if (!el || !prompt) return closeForm();
    const r = el.getBoundingClientRect();
    const { chain, jsxFrame, jsxSource } = componentInfo(el);
    const a = {
      id: state.nextId++,
      prompt,
      el,
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      html: el.outerHTML.slice(0, 400),
      componentChain: chain,
      jsxFrame,
      jsxSource,
      sources: [jsxSource, ...chain.map((c) => c.source)].filter(Boolean),
      peerCount: state.formPeers || 1, // how many instances of this JSX render on the page
      rect: {
        x: Math.round(r.x + scrollX),
        y: Math.round(r.y + scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
    if (state.formImage) a.pastedImage = state.formImage; // user's reference image
    state.annotations.push(a);
    addPin(a);
    updateCount();
    closeForm();
    toast(`Annotation #${a.id} saved — add more or hit "Send"`);
  }

  // Swallow app interactions while inspecting so clicks only select elements.
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    document.addEventListener(
      type,
      (e) => {
        if (!state.inspecting || onHost(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'click' && e.target instanceof Element) {
          setInspecting(false);
          openForm(e.target);
        }
      },
      true
    );
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        if (!ui.form.hidden) closeForm();
        else if (state.inspecting) setInspecting(false);
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !ui.form.hidden) saveAnnotation();
      if (e.altKey && e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        setToolbarHidden(!ui.toolbar.hidden);
      }
    },
    true
  );

  // ------------------------------------------------------------- agents
  //
  // The "Send to" target is fetched from the bridge's /agents registry
  // (populated as agents self-register via `install.mjs --agent <id>`, see
  // agents.mjs) and refreshed alongside the results poll below.

  const AGENT_KEY = `claude-annotator-agent-${PORT}`;
  let agents = [];
  // `selectedAgent` — not the live <select>.value — is the source of truth for
  // where a batch is sent. Keeping it in a variable means a background refresh
  // that rebuilds the <option>s can never silently change the target (the old
  // bug: the ~20s poll repopulated the dropdown mid-interaction and Send went
  // to whichever agent happened to land first, e.g. Antigravity).
  let selectedAgent = null;
  try {
    selectedAgent = localStorage.getItem(AGENT_KEY) || null;
  } catch {}
  let agentSig = ''; // signature of the currently-rendered option list

  function agentLabel(id) {
    return (agents.find((a) => a.id === id) || {}).label || id;
  }

  // Keep `selectedAgent` valid for the current list and reflect it in the
  // <select> without disturbing the user's choice.
  function syncSelectValue(list) {
    if (!selectedAgent || !list.some((a) => a.id === selectedAgent)) {
      // No valid saved pick (e.g. first run, or the bridge came up on a new
      // port). Prefer Claude over "whatever agent is listed first" so a batch
      // never silently defaults to an unexpected agent.
      const fromDom = list.find((a) => a.id === ui.agentSelect.value);
      const claude = list.find((a) => a.id === 'claude');
      selectedAgent = (fromDom || claude || list[0] || {}).id || selectedAgent;
    }
    if (selectedAgent && ui.agentSelect.value !== selectedAgent) {
      ui.agentSelect.value = selectedAgent;
    }
  }

  function populateAgentSelect(list) {
    const sig = list.map((a) => `${a.id}${a.label || a.id}`).join('');
    // Nothing to rebuild if the option set is identical — just re-assert the
    // selected value. This is the common case on every poll.
    if (sig === agentSig) return syncSelectValue(list);
    // Never rebuild the <option>s while the user has the dropdown open/focused;
    // doing so cancels their in-progress pick. Try again on the next poll.
    if (shadow.activeElement === ui.agentSelect) return;
    agentSig = sig;
    ui.agentSelect.innerHTML = '';
    for (const a of list) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label || a.id;
      ui.agentSelect.appendChild(opt);
    }
    syncSelectValue(list);
  }

  async function refreshAgents() {
    try {
      const res = await bridgeFetch('/agents');
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (Array.isArray(data.agents) && data.agents.length) {
        agents = data.agents;
        populateAgentSelect(agents);
      }
    } catch {
      // bridge offline — leave whatever options are already loaded
    }
  }

  ui.agentSelect.addEventListener('change', () => {
    selectedAgent = ui.agentSelect.value;
    try {
      localStorage.setItem(AGENT_KEY, selectedAgent);
    } catch {}
  });

  // ------------------------------------------------- per-agent modifier prompts
  //
  // Standing instructions the user attaches to a specific agent ("always use
  // Tailwind", "never touch shared components", ...). The source of truth is
  // the bridge's registry (agents.json — survives across projects/browsers);
  // localStorage is the offline fallback. Sent as `agentPrompt` on every batch
  // and also injected server-side by the bridge.

  const promptKey = (id) => `claude-annotator-prompt-${id}`;

  function promptFor(id) {
    const fromBridge = (agents.find((a) => a.id === id) || {}).prompt;
    if (typeof fromBridge === 'string' && fromBridge) return fromBridge;
    try {
      return localStorage.getItem(promptKey(id)) || '';
    } catch {
      return '';
    }
  }

  function renderSettings() {
    for (const row of ui.settingsList.querySelectorAll('.prompt-row')) row.remove();
    for (const a of agents) {
      const row = document.createElement('div');
      row.className = 'prompt-row';
      row.dataset.agent = a.id;
      const label = document.createElement('label');
      label.textContent = a.label || a.id;
      const ta = document.createElement('textarea');
      ta.placeholder = `Extra instructions sent with every batch to ${a.label || a.id} (optional)`;
      ta.value = promptFor(a.id);
      row.appendChild(label);
      row.appendChild(ta);
      ui.settingsList.appendChild(row);
    }
  }

  async function saveSettings() {
    let bridgeOk = true;
    for (const row of ui.settingsList.querySelectorAll('.prompt-row')) {
      const id = row.dataset.agent;
      const prompt = row.querySelector('textarea').value.trim();
      const entry = agents.find((a) => a.id === id);
      if (entry) entry.prompt = prompt || undefined;
      try {
        if (prompt) localStorage.setItem(promptKey(id), prompt);
        else localStorage.removeItem(promptKey(id));
      } catch {}
      try {
        const res = await bridgeFetch('/agents/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: id, prompt }),
        });
        if (!res.ok) throw new Error();
      } catch {
        bridgeOk = false;
      }
    }
    ui.settings.hidden = true;
    toast(bridgeOk ? 'Per-agent instructions saved ✓' : 'Saved locally — bridge offline, will apply when it is back.');
  }

  ui.settingsOpen.addEventListener('click', async () => {
    if (!ui.settings.hidden) {
      ui.settings.hidden = true;
      return;
    }
    await refreshAgents();
    renderSettings();
    ui.results.hidden = true;
    ui.settings.hidden = false;
  });
  ui.settingsClose.addEventListener('click', () => (ui.settings.hidden = true));
  ui.settingsSave.addEventListener('click', saveSettings);

  // ---------------------------------------------------------------- send

  // "30s ago" / "5m ago" for the bridge's lastSeenAt timestamps; '' if unusable.
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'just now';
    if (s < 90) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  }

  function buildPayload() {
    const agent = selectedAgent || ui.agentSelect.value || 'claude';
    const agentPrompt = promptFor(agent);
    return {
      url: location.href,
      title: document.title,
      sentAt: new Date().toISOString(),
      viewport: { w: innerWidth, h: innerHeight },
      agent,
      ...(agentPrompt ? { agentPrompt } : {}), // standing instructions for this agent
      screenshot: state.screenshots, // launcher captures a page screenshot when true
      annotations: state.annotations.map(({ el, ...rest }) => rest),
    };
  }

  async function send() {
    if (!state.annotations.length) {
      toast('No annotations yet — click "Annotate", pick an element, describe the change.');
      return;
    }
    const payload = buildPayload();
    const label = agentLabel(payload.agent);
    try {
      const res = await bridgeFetch('/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        // Bridge is up but refused the batch: too many unclaimed batches.
        // Keep the pins so nothing is lost.
        ui.dot.classList.add('on');
        const err = await res.json().catch(() => ({}));
        toast(`⚠ Queue is full${err.cap ? ` (${err.queued}/${err.cap})` : ''} for ${label} — nothing is draining its batches. Start its annotation loop or pick a different agent, then hit Send again — your pins are kept.`, 8000);
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ack = await res.json().catch(() => ({}));
      ui.dot.classList.add('on');
      const n = payload.annotations.length;
      // The bridge reports whether the target agent is actually there:
      // `waiting` = parked on /wait right now, `seen` = has connected to this
      // bridge before (mid-loop, will re-poll), `lastSeenAt` = when. Neither
      // seen nor waiting -> the batch went nowhere yet.
      if (ack.seen === false && ack.waiting === false) {
        // Keep the pins: the batch is queued at the bridge, but nobody is
        // acting on it — let the user switch agents and resend without
        // redoing their annotations.
        const cmd = `node wait.mjs --dir ${ack.dir || '<project>/.claude-annotations'} --agent ${payload.agent}`;
        toast(`⚠ ${label}'s annotation loop is not running on this bridge (batch queued). Start it with: ${cmd}${payload.agent === 'claude' ? ' — or run /annotate in Claude Code' : ''} — or pick another agent and hit Send again; your pins are kept.`, 8000);
        return;
      }
      if (ack.waiting === false) {
        const ago = timeAgo(ack.lastSeenAt);
        toast(`Sent ${n} annotation(s) to ${label} ✓ — ${label} is between batches${ago ? ` (last seen ${ago})` : ''} and will pick this up on its next poll.`, 6000);
      } else {
        toast(`Sent ${n} annotation(s) to ${label} ✓ — applied changes will show up in the ✓ panel.`, 6000);
      }
      clearAll();
    } catch {
      ui.dot.classList.remove('on');
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        toast(`Bridge is offline (${BRIDGE}) — annotations copied to clipboard. Start the bridge (node server.mjs) or paste them into ${label}.`, 8000);
      } catch {
        console.log('[claude-annotator] payload:', payload);
        toast(`Bridge offline (${BRIDGE}) and clipboard unavailable — payload logged to console.`, 8000);
      }
    }
  }

  // 📷 toggle — off by default: no screenshots are captured or sent unless on.
  const SHOT_KEY = `claude-annotator-shots-${PORT}`;

  function setScreenshots(on) {
    state.screenshots = on;
    ui.shot.classList.toggle('active', on);
    try {
      localStorage.setItem(SHOT_KEY, on ? '1' : '');
    } catch {}
  }
  try {
    if (localStorage.getItem(SHOT_KEY) === '1') setScreenshots(true);
  } catch {}

  ui.inspect.addEventListener('click', () => setInspecting(!state.inspecting));
  ui.shot.addEventListener('click', () => {
    setScreenshots(!state.screenshots);
    toast(
      state.screenshots
        ? 'Page screenshot ON — each send also attaches a full-page screenshot of the app. (Reference images you paste into a note are always sent, regardless of this.)'
        : 'Page screenshot OFF — sends no longer include a full-page screenshot. You can still paste a reference image into any note.'
    );
  });
  ui.send.addEventListener('click', send);
  ui.clear.addEventListener('click', () => {
    clearAll();
    toast('Annotations cleared');
  });
  ui.hide.addEventListener('click', () => setToolbarHidden(true));
  ui.fab.addEventListener('click', () => setToolbarHidden(false));
  ui.formSave.addEventListener('click', saveAnnotation);
  ui.formCancel.addEventListener('click', closeForm);
  ui.resultsClose.addEventListener('click', () => (ui.results.hidden = true));
  ui.resultsToggle.addEventListener('click', () => {
    if (ui.results.hidden && !ui.resultsList.children.length) {
      toast('No changes reported yet — recently applied changes (with the agent + model that made them) appear here.');
      return;
    }
    ui.settings.hidden = true;
    ui.results.hidden = !ui.results.hidden;
  });

  // -------------------------------------------------- applied-change reports
  //
  // Claude (via report.mjs) posts what it changed to the bridge; we poll and
  // render it in the "Changes applied" panel. Everything is inserted with
  // textContent — plain words only, no HTML.

  const RESULT_KEY = `claude-annotator-seen-result-${PORT}`;
  let seenResult = 0; // newest report already announced to the user (survives reloads)
  let renderedResult = 0; // newest report rendered in the panel this page load
  try {
    seenResult = Number(localStorage.getItem(RESULT_KEY)) || 0;
  } catch {}

  function renderResult(r) {
    const batch = document.createElement('div');
    batch.className = 'result-batch';
    if (r.at || r.agent) {
      const t = document.createElement('div');
      t.className = 'result-time';
      if (r.at) t.appendChild(document.createTextNode(new Date(r.at).toLocaleTimeString() + '  '));
      if (r.agent) {
        const who = document.createElement('span');
        who.className = 'result-agent';
        who.textContent = agentLabel(r.agent);
        t.appendChild(who);
      }
      if (r.model) {
        const mo = document.createElement('span');
        mo.className = 'result-model';
        mo.textContent = ` · ${r.model}`;
        t.appendChild(mo);
      }
      batch.appendChild(t);
    }
    if (r.message) {
      const m = document.createElement('div');
      m.className = 'result-msg';
      m.textContent = r.message;
      batch.appendChild(m);
    }
    for (const item of r.items || []) {
      const row = document.createElement('div');
      row.className = 'result-item';
      const status = item.status === 'failed' || item.status === 'skipped' ? item.status : 'done';
      const st = document.createElement('span');
      st.className = 'st ' + status;
      st.textContent = status === 'done' ? '✓' : status === 'failed' ? '✕' : '↷';
      row.appendChild(st);
      const body = document.createElement('div');
      const s = document.createElement('div');
      s.textContent = (item.id ? `#${item.id} — ` : '') + (item.summary || '(no summary)');
      body.appendChild(s);
      if (Array.isArray(item.files) && item.files.length) {
        const f = document.createElement('div');
        f.className = 'files';
        f.textContent = item.files.join('  ·  ');
        body.appendChild(f);
      }
      row.appendChild(body);
      batch.appendChild(row);
    }
    ui.resultsList.appendChild(batch);
    while (ui.resultsList.children.length > 8) ui.resultsList.firstChild.remove();
    ui.resultsList.scrollTop = ui.resultsList.scrollHeight;
  }

  let pollTick = 0;
  async function poll() {
    if (document.hidden) return;
    // The agent registry changes rarely — refresh it every ~20s (and when the
    // settings panel opens), not on every 4s results poll.
    if (pollTick++ % 5 === 0) await refreshAgents();
    let data;
    try {
      const res = await bridgeFetch(`/results?since=${renderedResult}`);
      if (!res.ok) throw new Error();
      data = await res.json();
      ui.dot.classList.add('on');
    } catch {
      ui.dot.classList.remove('on');
      return;
    }
    if (!data.results || !data.results.length) return;
    for (const r of data.results) renderResult(r);
    renderedResult = data.latest;
    // Only announce reports the user hasn't seen (dev-server reloads re-render
    // history into the panel silently).
    const fresh = data.results.filter((r) => r.id > seenResult);
    if (fresh.length) {
      seenResult = data.latest;
      try {
        localStorage.setItem(RESULT_KEY, String(seenResult));
      } catch {}
      ui.results.hidden = false;
      const n = fresh.reduce((sum, r) => sum + (r.items?.length || (r.message ? 1 : 0)), 0);
      // Attribute the toast to the reporting agent(s) — with its exact model
      // when the report carried one.
      const who = [...new Set(fresh.map((r) => (r.agent ? agentLabel(r.agent) + (r.model ? ` (${r.model})` : '') : null)).filter(Boolean))];
      toast(`${who.length ? who.join(' + ') : 'Agent'} applied ${n} change${n === 1 ? '' : 's'} — details in the panel.`);
    }
  }
  poll();
  setInterval(poll, 4000);

  function pingBridge() {
    bridgeFetch('/ping')
      .then((r) => ui.dot.classList.toggle('on', r.ok))
      .catch(() => ui.dot.classList.remove('on'));
  }

  let startHidden = false;
  try {
    startHidden = localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {}
  if (startHidden) setToolbarHidden(true);
  else restoreToolbarPos();

  // Exposed for the launcher's self-test; not used by the UI.
  window.__claudeAnnotatorDebug = {
    componentInfo,
    cssPath,
    refreshAgents,
    populateAgentSelect,
    buildPayload,
    getSelectedAgent: () => selectedAgent,
  };
})();
