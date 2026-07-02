#!/usr/bin/env node
// Posts an applied-changes report to the running bridge so the user sees,
// right inside the annotated page, exactly what Claude changed.
//
// Usage:
//   node report.mjs --file results.json [--dir .claude-annotations] [--port N] [--agent <id>]
//   node report.mjs --message "Rounded the hero card corners" [...]
//
//   --agent defaults to "claude" — pass the same id you used with wait.mjs so
//   the "Changes applied" panel can attribute the report to the right agent.
//
// results.json shape (all fields optional except items[].summary):
//   {
//     "message": "one-line headline for the whole batch",
//     "items": [
//       { "id": 1, "status": "done" | "failed" | "skipped",
//         "summary": "what changed, in plain words",
//         "files": ["src/components/site/header.tsx"] }
//     ]
//   }
//
// Exit codes: 0 delivered, 1 bad input, 3 bridge unreachable.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeArg } from './cli.mjs';

const argv = process.argv.slice(2);
const arg = makeArg(argv);
const dir = path.resolve(arg('dir', path.join(process.cwd(), '.claude-annotations')));
const file = arg('file', null);
const message = arg('message', null);
const agent = arg('agent', 'claude');
let port = Number(arg('port', 0));

let payload;
if (file) {
  try {
    payload = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (e) {
    console.error(`[report] could not read ${file}: ${e.message}`);
    process.exit(1);
  }
} else if (message) {
  payload = { message, items: [] };
} else {
  console.error('[report] pass --file results.json or --message "text"');
  process.exit(1);
}
if (!payload.agent) payload.agent = agent;

if (!port) {
  try {
    port = JSON.parse(readFileSync(path.join(dir, 'bridge.json'), 'utf8')).port;
  } catch {
    console.error(`[report] no --port given and no readable ${path.join(dir, 'bridge.json')} — is the annotator running?`);
    process.exit(3);
  }
}

try {
  const res = await fetch(`http://localhost:${port}/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const { id } = await res.json();
  console.log(`[report] delivered report #${id} (${payload.items?.length ?? 0} item(s)) — it will appear in the browser within a few seconds.`);
} catch (e) {
  console.error(`[report] bridge unreachable on port ${port}: ${e.message}`);
  process.exit(3);
}
