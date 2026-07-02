#!/usr/bin/env node
// Claude Annotator launcher: starts a local bridge server, opens the project
// in Chromium with the annotator extension loaded, and KEEPS RUNNING — every
// "Send to Claude" batch is sourcemap-resolved and written to
// <dir>/inbox/<timestamp>.json (+ latest.json), and applied-change reports
// posted via report.mjs show up inside the page. Claude Code picks up each
// batch by running wait.mjs in the background.
//
// Exits when the browser is closed (0 if any batch was received, else 2),
// or right after the first batch with --once (legacy single-shot mode).
//
// Usage: node launch.mjs [--url http://localhost:3000]
//                        [--dir <project>/.claude-annotations]
//                        [--out path/latest.json]   (legacy; implies --dir dirname)
//                        [--port 4747] [--headless] [--once]
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveAnnotations } from './resolve.mjs';
import { createBridge, listenOnFreePort, writeBatch, writeBridgeInfo, clearBridgeInfo } from './bridge.mjs';
import { makeArg } from './cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(__dirname, 'extension');

const argv = process.argv.slice(2);
const arg = makeArg(argv);
const url = arg('url', 'http://localhost:3000');
const legacyOut = arg('out', null);
const dir = path.resolve(
  arg('dir', legacyOut ? path.dirname(path.resolve(legacyOut)) : path.join(process.cwd(), '.claude-annotations'))
);
const basePort = Number(arg('port', 4747));
const once = argv.includes('--once');
const headless = argv.includes('--headless');

let batchCount = 0;
let context = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearBridgeInfo(dir);
  const closeBrowser = context ? context.close().catch(() => {}) : Promise.resolve();
  closeBrowser.finally(() => {
    bridge.close();
    process.exit(code);
  });
}

// ---------------------------------------------------------------- bridge

// With the extension's 📷 toggle on, the batch carries `screenshot: true` —
// capture the sending page full-page (annotator UI hidden so only the app
// shows) and hand the agent the file path as `screenshotPath`.
async function capturePageShot(data, agent) {
  const page = (context?.pages() || []).find((p) => p.url() === data.url) || context?.pages()[0];
  if (!page) return;
  const shotsDir = path.join(dir, agent, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const shotPath = path.join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-page.png`);
  const setUiHidden = (hidden) =>
    page.evaluate((h) => {
      const host = document.getElementById('claude-annotator-host');
      if (host) host.style.visibility = h ? 'hidden' : '';
    }, hidden);
  await setUiHidden(true);
  try {
    await page.screenshot({ path: shotPath, fullPage: true });
  } finally {
    await setUiHidden(false).catch(() => {});
  }
  data.screenshotPath = shotPath;
  console.log(`[bridge] page screenshot: ${shotPath}`);
}

const projectRoot = path.dirname(dir); // `dir` is <project>/.claude-annotations
const bridge = createBridge({
  dir,
  onBatch: async (data, agent) => {
    try {
      await resolveAnnotations(data, projectRoot); // map compiled frames -> original src files
    } catch (e) {
      console.warn(`[resolve] sourcemap resolution failed: ${e.message}`);
    }
    if (data.screenshot) {
      try {
        await capturePageShot(data, agent);
      } catch (e) {
        console.warn(`[shot] page screenshot failed: ${e.message}`);
      }
    }
    const file = writeBatch(data, dir, agent);
    batchCount++;
    console.log(`[bridge] batch #${batchCount} for "${agent}": ${data.annotations?.length ?? 0} annotation(s) from ${data.url}`);
    console.log(`ANNOTATIONS_FILE=${file}`);
    if (once) setTimeout(() => shutdown(0), 600); // let the in-page toast show
    return file;
  },
});

let port;
try {
  port = await listenOnFreePort(bridge, basePort);
} catch (e) {
  console.error(`[bridge] could not listen on ${basePort}..${basePort + 9}: ${e.message}`);
  process.exit(1);
}
console.log(`[bridge] listening on http://localhost:${port}`);
console.log(`BRIDGE_PORT=${port}`);
console.log(`[bridge] batches will be written to ${dir}`);
writeBridgeInfo(dir, { port, url, mode: once ? 'once' : 'watch', startedAt: new Date().toISOString() });

// ---------------------------------------------------------------- browser

// Note: branded Chrome >= 137 ignores --load-extension, so this uses
// Playwright's bundled Chromium (npx playwright install chromium).
const profile = mkdtempSync(path.join(os.tmpdir(), 'claude-annotator-'));
context = await chromium.launchPersistentContext(profile, {
  // 'chromium' channel forces the new headless mode, which (unlike the default
  // headless shell) supports extensions.
  channel: 'chromium',
  headless,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-default-browser-check',
  ],
});
await context.addInitScript(`window.__CLAUDE_ANNOTATOR_PORT = ${port};`);
context.on('close', () => shutdown(batchCount ? 0 : 2));

const page = context.pages()[0] || (await context.newPage());
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`[browser] opened ${url}`);
  const injected = await page
    .waitForFunction(() => window.__claudeAnnotator === true, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (injected) {
    console.log('[browser] annotator extension active — toolbar is at the bottom-right.');
  } else if (/localhost|127\.0\.0\.1/.test(url)) {
    console.warn('[browser] extension content script not detected on this page.');
  }
} catch (e) {
  console.error(`[browser] could not open ${url}: ${e.message}`);
}
console.log(
  once
    ? '[waiting] annotate elements, then click "Send to Claude" (closing the browser cancels).'
    : '[watching] annotate any time — every "Send to Claude" batch is delivered automatically. Close the browser to end the session.'
);
