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
import { findRunningBridge } from './client.mjs';

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

// Singleton per project: if a live bridge already serves this --dir, REUSE it
// instead of spawning a second browser on a port the extension knows nothing
// about (the old behavior — the classic "agent B relaunches and then never
// receives anything" failure). The caller just proceeds to wait.mjs/agent.mjs.
const running = await findRunningBridge(dir);
if (running) {
  console.log(`[launch] annotator already running for this project (port ${running.port}${running.pid ? `, pid ${running.pid}` : ''}) — reusing it, no new browser.`);
  console.log(`BRIDGE_PORT=${running.port}`);
  console.log('ALREADY_RUNNING=1');
  console.log('[launch] proceed to wait.mjs / agent.mjs — do NOT treat this exit as the session ending.');
  process.exit(0);
}

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

// The live app page in the annotator browser (the most recently focused
// non-closed one). Used for screenshots and agent-driven navigation.
function currentPage(preferUrl) {
  const pages = (context?.pages() || []).filter((p) => !p.isClosed());
  if (preferUrl) {
    const match = pages.find((p) => p.url() === preferUrl);
    if (match) return match;
  }
  return pages[pages.length - 1] || null;
}

// Run `fn` with the annotator's own toolbar hidden, so a screenshot shows only
// the app. Always restores visibility, even if `fn` throws.
async function withUiHidden(page, fn) {
  const set = (hidden) =>
    page
      .evaluate((h) => {
        const host = document.getElementById('claude-annotator-host');
        if (host) host.style.visibility = h ? 'hidden' : '';
      }, hidden)
      .catch(() => {});
  await set(true);
  try {
    return await fn();
  } finally {
    await set(false);
  }
}

// Screenshot a rectangle given in PAGE coordinates (rect.x/y include scroll,
// as the extension records them). Scroll it into view, then clip against the
// viewport, clamped so the region never spills outside it (Playwright errors
// otherwise).
async function captureRect(page, rect, pad, shotPath) {
  const x = Number(rect.x) || 0;
  const y = Number(rect.y) || 0;
  const w = Number(rect.w ?? rect.width) || 0;
  const h = Number(rect.h ?? rect.height) || 0;
  await page.evaluate((r) => window.scrollTo(Math.max(0, r.x - 40), Math.max(0, r.y - 120)), { x, y });
  const v = await page.evaluate(() => ({ sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight }));
  const cx = Math.max(0, x - v.sx - pad);
  const cy = Math.max(0, y - v.sy - pad);
  const clip = {
    x: cx,
    y: cy,
    width: Math.max(1, Math.min(w + pad * 2, v.vw - cx)),
    height: Math.max(1, Math.min(h + pad * 2, v.vh - cy)),
  };
  await page.screenshot({ path: shotPath, clip });
}

// With the extension's 📷 toggle on, the batch carries `screenshot: true` —
// capture the sending page full-page (annotator UI hidden so only the app
// shows) and hand the agent the file path as `screenshotPath`.
async function capturePageShot(data, agent) {
  const page = currentPage(data.url);
  if (!page) return;
  const shotsDir = path.join(dir, agent, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const shotPath = path.join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-page.png`);
  await withUiHidden(page, () => page.screenshot({ path: shotPath, fullPage: true }));
  data.screenshotPath = shotPath;
  console.log(`[bridge] page screenshot: ${shotPath}`);
}

// Agent-driven browser control (via POST /command). Lets the coding agent grab
// a tight crop of an exact area, jump to another route, or reload after edits —
// without the user doing anything. Returns a small result the agent reads.
async function handleCommand(cmd) {
  const type = cmd.type;
  const page = currentPage(cmd.url && type !== 'navigate' ? cmd.url : undefined);
  if (!page) throw new Error('no open page in the annotator browser');

  if (type === 'navigate') {
    if (!cmd.url) throw new Error('navigate needs a url');
    await page.goto(cmd.url, { waitUntil: cmd.waitUntil || 'domcontentloaded' });
    await page.waitForFunction(() => window.__claudeAnnotator === true, null, { timeout: 8000 }).catch(() => {});
    return { url: page.url() };
  }

  if (type === 'reload') {
    await page.reload({ waitUntil: cmd.waitUntil || 'domcontentloaded' });
    return { url: page.url() };
  }

  if (type === 'screenshot' || type === 'shot') {
    const agent = cmd.agent || 'claude';
    const shotsDir = path.join(dir, agent, 'shots');
    mkdirSync(shotsDir, { recursive: true });
    const kind = cmd.selector || cmd.rect ? 'crop' : cmd.fullPage ? 'page' : 'view';
    const shotPath = path.join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.png`);
    const pad = Number.isFinite(cmd.padding) ? Number(cmd.padding) : 12;
    await withUiHidden(page, async () => {
      if (cmd.selector) {
        const loc = page.locator(cmd.selector).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await loc.screenshot({ path: shotPath });
      } else if (cmd.rect) {
        await captureRect(page, cmd.rect, pad, shotPath);
      } else {
        await page.screenshot({ path: shotPath, fullPage: !!cmd.fullPage });
      }
    });
    return { path: shotPath, url: page.url() };
  }

  throw new Error(`unknown command type: ${cmd.type ?? '(none)'}`);
}

const projectRoot = path.dirname(dir); // `dir` is <project>/.claude-annotations
const bridge = createBridge({
  dir,
  onCommand: handleCommand,
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
