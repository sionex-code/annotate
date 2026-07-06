#!/usr/bin/env node
// Waits for the NEXT annotation batch addressed to a given agent from a
// running bridge (launch.mjs or server.mjs) and exits — run it in the
// background and you are woken up the moment the user picks your agent and
// clicks "Send". Re-run it after processing each batch to keep the loop going.
//
// Usage: node wait.mjs [--dir <project>/.claude-annotations] [--port N]
//                      [--agent <id>] [--timeout <seconds>]
//   Port is read from <dir>/bridge.json when --port is omitted.
//   --agent defaults to "claude" — pass the same id you registered via
//   `install.mjs --agent <id>` so you only get batches addressed to you.
//   --timeout makes it exit 4 after N seconds with no batch (nothing is lost;
//   run it again) — for agents whose shell tools kill long foreground calls.
//
// Exit codes:
//   0  batch received — path printed as ANNOTATIONS_FILE=...
//   3  bridge is gone (browser closed / launcher stopped) — session over
//   4  --timeout elapsed with no batch — run the same command again
import path from 'node:path';
import { makeArg } from './cli.mjs';
import { readBridgeInfo, waitForBatch } from './client.mjs';

const argv = process.argv.slice(2);
const arg = makeArg(argv);
const dir = path.resolve(arg('dir', path.join(process.cwd(), '.claude-annotations')));
const agent = arg('agent', 'claude');
const timeoutSec = Number(arg('timeout', 0));
let port = Number(arg('port', 0));

if (!port) {
  port = readBridgeInfo(dir)?.port;
  if (!port) {
    console.error(`[wait] no --port given and no readable ${path.join(dir, 'bridge.json')} — is the annotator running?`);
    process.exit(3);
  }
}

console.log(`[wait] waiting for the next "${agent}" annotation batch on http://localhost:${port} ...`);

// No process.exit() after fetch activity — on Windows/Node 24 it can trip a
// libuv assertion and clobber the exit code; natural exit is clean and fast.
const outcome = await waitForBatch({ port, agent, timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : 0 });
if (outcome.batch) {
  console.log(`[wait] batch #${outcome.batch.n}: ${outcome.batch.count} annotation(s) from ${outcome.batch.url}`);
  console.log(`ANNOTATIONS_FILE=${outcome.batch.file}`);
  process.exitCode = 0;
} else if (outcome.timedOut) {
  console.log(`NO_BATCH_YET — nothing arrived within ${timeoutSec}s. Run the same command again to keep listening.`);
  process.exitCode = 4;
} else {
  console.error('[wait] bridge is gone — the annotator session has ended.');
  process.exitCode = 3;
}
