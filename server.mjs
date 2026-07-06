#!/usr/bin/env node
// Standalone bridge server — listens for annotation batches from the Claude
// Annotator extension WITHOUT launching a browser. Use it when the extension
// is loaded in your everyday Chrome (chrome://extensions -> Load unpacked).
//
// Usage: node server.mjs [--port 4747] [--out-dir DIR] [--once]
//   --port     port the extension posts to (default 4747)
//   --out-dir  where batches are written (default <cwd>/.claude-annotations)
//   --once     exit after the first batch — lets Claude Code run this in the
//              background and get woken up when annotations arrive
//
// Every batch is sourcemap-resolved and written to:
//   <out-dir>/latest.json            (always the newest batch)
//   <out-dir>/inbox/<timestamp>.json (one file per batch)
// In persistent mode, Claude Code picks up each batch by running wait.mjs,
// and report.mjs pushes applied-change summaries back into the page.
import path from 'node:path';
import { resolveAnnotations } from './resolve.mjs';
import { createBridge, listenOnFreePort, writeBatch, writeBridgeInfo, clearBridgeInfo } from './bridge.mjs';
import { makeArg } from './cli.mjs';
import { findRunningBridge } from './client.mjs';

const argv = process.argv.slice(2);
const arg = makeArg(argv);
const basePort = Number(arg('port', 4747));
const outDir = path.resolve(arg('out-dir', path.join(process.cwd(), '.claude-annotations')));
const once = argv.includes('--once');

// Singleton per project: reuse a live bridge for this directory instead of
// failing on the taken port (or worse, racing it).
const running = await findRunningBridge(outDir);
if (running) {
  console.log(`[server] bridge already running for this project (port ${running.port}${running.pid ? `, pid ${running.pid}` : ''}) — reusing it.`);
  console.log(`BRIDGE_PORT=${running.port}`);
  console.log('ALREADY_RUNNING=1');
  process.exit(0);
}

let batches = 0;

const projectRoot = path.dirname(outDir); // outDir is typically <project>/.claude-annotations
const server = createBridge({
  dir: outDir,
  onBatch: async (data, agent) => {
    try {
      await resolveAnnotations(data, projectRoot); // map compiled frames -> original src files
    } catch (e) {
      console.warn(`[resolve] sourcemap resolution failed: ${e.message}`);
    }
    if (data.screenshot) {
      // No Playwright here — pasted images are still saved by writeBatch,
      // but a page screenshot needs the launch.mjs browser.
      console.log('[server] page screenshot requested, but only the Playwright launcher (launch.mjs) can capture one — pasted images are still attached.');
    }
    const file = writeBatch(data, outDir, agent);
    batches++;
    console.log(`[server] batch #${batches} for "${agent}": ${data.annotations?.length ?? 0} annotation(s) from ${data.url || 'unknown url'}`);
    console.log(`ANNOTATIONS_FILE=${file}`);
    if (once) {
      setTimeout(() => {
        clearBridgeInfo(outDir);
        server.close();
        process.exit(0);
      }, 200);
    }
    return file;
  },
});

let port;
try {
  // The extension only knows the default port, so don't walk far: fail loudly
  // if 4747 is taken by something that isn't answering for us.
  port = await listenOnFreePort(server, basePort, 1);
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`[server] port ${basePort} is already in use — is another bridge/launcher running?`);
    process.exit(1);
  }
  throw e;
}

writeBridgeInfo(outDir, { port, mode: once ? 'once' : 'watch', startedAt: new Date().toISOString() });
process.on('SIGINT', () => {
  clearBridgeInfo(outDir);
  process.exit(0);
});

console.log(`[server] listening on http://localhost:${port} (pid ${process.pid})`);
console.log(`BRIDGE_PORT=${port}`);
console.log(`[server] batches will be written to ${outDir}`);
console.log(once ? '[server] --once: exiting after the first batch.' : '[server] persistent mode — Ctrl+C to stop.');
