#!/usr/bin/env node
// Drive the annotator's Playwright browser from your coding agent — so you can
// SEE an exact area, jump to another route, or reload after editing, without
// asking the user to do anything. Talks to the running launcher via the bridge
// (POST /command); the launcher owns the page.
//
// Usage:
//   node browse.mjs shot   [--selector "<css>" | --rect x,y,w,h | --full] [--pad N] [--dir DIR] [--agent id]
//   node browse.mjs shot   --annotation <batch.json> --id <n>   (crop that annotation's element)
//   node browse.mjs open   --url <url>                          (navigate the page)
//   node browse.mjs reload
//
//   The subcommand is the first argument. Port is read from <dir>/bridge.json
//   unless you pass --port. A saved screenshot is printed as SCREENSHOT=<path>
//   (open it with your image-reading tool); navigation prints PAGE_URL=<url>.
//
// Exit codes: 0 ok, 1 bad input, 2 command unsupported (browser-less bridge),
//             3 bridge unreachable / gone.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeArg } from './cli.mjs';
import { readBridgeInfo, sendCommand } from './client.mjs';

const argv = process.argv.slice(2);
const sub = (argv[0] && !argv[0].startsWith('--') ? argv[0] : '').toLowerCase();
const arg = makeArg(argv);
const dir = path.resolve(arg('dir', path.join(process.cwd(), '.claude-annotations')));
const agent = arg('agent', 'claude');
let port = Number(arg('port', 0));

if (!sub || !['shot', 'screenshot', 'open', 'navigate', 'go', 'reload'].includes(sub)) {
  console.error('[browse] first argument must be: shot | open | reload');
  console.error('  node browse.mjs shot --selector "<css>"   (crop an element)');
  console.error('  node browse.mjs shot --rect x,y,w,h        (crop a page-coordinate box)');
  console.error('  node browse.mjs shot --annotation <batch.json> --id <n>');
  console.error('  node browse.mjs shot --full                (full-page screenshot)');
  console.error('  node browse.mjs open --url <url>           (navigate)');
  console.error('  node browse.mjs reload');
  process.exit(1);
}

if (!port) {
  port = readBridgeInfo(dir)?.port;
  if (!port) {
    console.error(`[browse] no --port given and no readable ${path.join(dir, 'bridge.json')} — is the annotator running?`);
    process.exit(3);
  }
}

// Build the command body from flags.
let body;
if (sub === 'reload') {
  body = { type: 'reload' };
} else if (sub === 'open' || sub === 'navigate' || sub === 'go') {
  const url = arg('url', null);
  if (!url) {
    console.error('[browse] open needs --url <url>');
    process.exit(1);
  }
  body = { type: 'navigate', url };
} else {
  // shot / screenshot
  body = { type: 'screenshot', agent };
  const selector = arg('selector', null);
  const rectStr = arg('rect', null);
  const annotation = arg('annotation', null);
  const id = arg('id', null);
  const pad = arg('pad', null);
  if (pad != null && pad !== '') body.padding = Number(pad);
  if (argv.includes('--full')) body.fullPage = true;

  if (annotation) {
    // Crop a specific annotation's element from a batch file — prefer its CSS
    // selector (auto-scrolls, always in frame), fall back to its page rect.
    let batch;
    try {
      batch = JSON.parse(readFileSync(path.resolve(annotation), 'utf8'));
    } catch (e) {
      console.error(`[browse] could not read --annotation ${annotation}: ${e.message}`);
      process.exit(1);
    }
    const list = batch.annotations || [];
    const a = id != null ? list.find((x) => String(x.id) === String(id)) : list[0];
    if (!a) {
      console.error(`[browse] annotation ${id != null ? `#${id}` : ''} not found in ${annotation}`);
      process.exit(1);
    }
    if (a.selector) body.selector = a.selector;
    else if (a.rect) body.rect = a.rect;
    else {
      console.error('[browse] that annotation has no selector or rect to crop');
      process.exit(1);
    }
  } else if (selector) {
    body.selector = selector;
  } else if (rectStr) {
    const [x, y, w, h] = rectStr.split(',').map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
      console.error('[browse] --rect must be x,y,w,h (page coordinates, numbers)');
      process.exit(1);
    }
    body.rect = { x, y, w, h };
  }
  // else: no target -> full viewport (or --full for the whole page)
}

try {
  const { status, ok, data } = await sendCommand(port, body);
  if (status === 501) {
    console.error(`[browse] ${data.message || 'this bridge cannot control a browser'}`);
    process.exit(2);
  }
  if (!ok) {
    console.error(`[browse] command failed: ${data.message || `HTTP ${status}`}`);
    process.exit(3);
  }
  if (data.path) console.log(`SCREENSHOT=${data.path}`);
  if (data.url) console.log(`PAGE_URL=${data.url}`);
  console.log(`[browse] ${sub} ok`);
} catch (e) {
  console.error(`[browse] bridge unreachable on port ${port}: ${e.message}`);
  process.exit(3);
}
