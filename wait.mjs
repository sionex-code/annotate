#!/usr/bin/env node
// Waits for the NEXT annotation batch addressed to a given agent from a
// running bridge (launch.mjs or server.mjs) and exits — run it in the
// background and you are woken up the moment the user picks your agent and
// clicks "Send". Re-run it after processing each batch to keep the loop going.
//
// Usage: node wait.mjs [--dir <project>/.claude-annotations] [--port N] [--agent <id>]
//   Port is read from <dir>/bridge.json when --port is omitted.
//   --agent defaults to "claude" — pass the same id you registered via
//   `install.mjs --agent <id>` so you only get batches addressed to you.
//
// Exit codes:
//   0  batch received — path printed as ANNOTATIONS_FILE=...
//   3  bridge is gone (browser closed / launcher stopped) — session over
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeArg } from './cli.mjs';

const argv = process.argv.slice(2);
const arg = makeArg(argv);
const dir = path.resolve(arg('dir', path.join(process.cwd(), '.claude-annotations')));
const agent = arg('agent', 'claude');
let port = Number(arg('port', 0));

if (!port) {
  try {
    port = JSON.parse(readFileSync(path.join(dir, 'bridge.json'), 'utf8')).port;
  } catch {
    console.error(`[wait] no --port given and no readable ${path.join(dir, 'bridge.json')} — is the annotator running?`);
    process.exit(3);
  }
}

const base = `http://localhost:${port}`;
console.log(`[wait] waiting for the next "${agent}" annotation batch on ${base} ...`);

let downChecks = 0;
for (;;) {
  try {
    const res = await fetch(`${base}/wait?agent=${encodeURIComponent(agent)}`);
    if (res.ok) {
      const b = await res.json();
      console.log(`[wait] batch #${b.n}: ${b.count} annotation(s) from ${b.url}`);
      console.log(`ANNOTATIONS_FILE=${b.file}`);
      process.exit(0);
    }
    downChecks = 0; // reachable but odd status — just retry
  } catch {
    // Long-poll aborted (fetch's ~5 min header timeout) or bridge gone — probe.
    try {
      await fetch(`${base}/ping`);
      downChecks = 0;
    } catch {
      if (++downChecks >= 3) {
        console.error('[wait] bridge is gone — the annotator session has ended.');
        process.exit(3);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
