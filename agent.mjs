#!/usr/bin/env node
// ONE-COMMAND entry point for any coding agent — designed so even a weak
// agent can run the whole annotate loop with a single, repeatable command:
//
//   node agent.mjs --agent <your-id> --dir <project>/.claude-annotations --url <dev-server-url>
//
// What it does, every time it runs:
//   1. registers <your-id> in the extension's "Send to" dropdown,
//   2. REUSES the already-running browser+bridge for this project if there is
//      one (it NEVER spawns a second Playwright browser), otherwise launches
//      it detached in the background,
//   3. waits up to --timeout seconds (default 90, safely under common shell
//      tool timeouts) for the next batch addressed to <your-id>,
//   4. prints the batch JSON plus exact instructions for implementing and
//      reporting it.
//
// Exit codes — branch on these, nothing else:
//   0  batch printed below ANNOTATIONS_FILE=...  -> implement, report, re-run
//   4  NO_BATCH_YET (timeout)                    -> just re-run the same command
//   3  session over / cannot start               -> stop, tell the user why
//
// Flags: --agent <id>      your identity (default "claude")
//        --dir <path>      annotations dir (default <cwd>/.claude-annotations)
//        --url <url>       the project's dev server (default http://localhost:3000)
//        --timeout <sec>   how long to wait for a batch before exit 4 (default 90)
//        --port <n>        bridge base port when launching fresh (default 4747)
//        --no-launch       never start a browser, only reuse a running one
//        --headless        launch the browser headless (testing/CI)
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeArg } from './cli.mjs';
import { registerAgent, labelFor, loadAgents } from './agents.mjs';
import { findRunningBridge, waitForBatch } from './client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = makeArg(argv);
const agent = arg('agent', 'claude').toLowerCase();
const dir = path.resolve(arg('dir', path.join(process.cwd(), '.claude-annotations')));
const url = arg('url', 'http://localhost:3000');
const timeoutSec = Number(arg('timeout', 90));
const basePort = Number(arg('port', 4747));
const noLaunch = argv.includes('--no-launch');

// NOTE: this script deliberately never calls process.exit() — on Windows,
// exiting while undici (fetch) handles are still closing trips a libuv
// assertion and clobbers the exit code (observed on Node 24). Natural exit
// with process.exitCode is clean and takes <300ms.
async function main() {
  // 1. Make sure this agent exists in the "Send to" dropdown.
  if (!loadAgents().some((a) => a.id === agent)) {
    registerAgent(agent, labelFor(agent));
    console.log(`[agent] registered "${agent}" — it now appears in the browser's "Send to" dropdown.`);
  }

  // 2. Reuse the running session, or launch one detached.
  let running = await findRunningBridge(dir);
  if (running) {
    console.log(`[agent] annotator already running for this project (port ${running.port}) — reusing it.`);
  } else if (noLaunch) {
    console.error('[agent] no annotator running for this project and --no-launch was given. Start it first (node launch.mjs) or drop --no-launch.');
    return 3;
  } else {
    // Refuse to open a browser onto a dead dev server — the extension can't
    // inject into Chrome's error page, so the session would look broken.
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) });
    } catch {
      console.error(`DEV_SERVER_NOT_RUNNING — nothing answered at ${url}.`);
      console.error('[agent] start the project\'s dev server first (detached/background so it survives this call), wait for it to answer, then re-run this exact command.');
      console.error('[agent] if the dev server uses a different url/port, pass it with --url.');
      return 3;
    }
    mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, 'launcher.log');
    const fd = openSync(logFile, 'a');
    const launchArgs = [path.join(HERE, 'launch.mjs'), '--url', url, '--dir', dir, '--port', String(basePort)];
    if (argv.includes('--headless')) launchArgs.push('--headless');
    spawn(process.execPath, launchArgs, {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    }).unref();
    console.log(`[agent] launching browser + bridge in the background (log: ${logFile}) ...`);
    const deadline = Date.now() + 60_000;
    while (!running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      running = await findRunningBridge(dir);
    }
    if (!running) {
      console.error(`[agent] the annotator did not come up within 60s — check ${logFile}.`);
      console.error(`[agent] if Chromium is missing, run: npx --prefix "${HERE}" playwright install chromium — then re-run this command.`);
      return 3;
    }
    console.log(`[agent] browser is open on ${url} — tell the user to annotate elements, pick "${labelFor(agent)}" in the toolbar dropdown, and click Send.`);
  }

  // 3. Wait (bounded) for the next batch addressed to this agent.
  console.log(`[agent] waiting up to ${timeoutSec}s for the next "${agent}" batch on port ${running.port} ...`);
  const outcome = await waitForBatch({ port: running.port, agent, timeoutMs: timeoutSec * 1000 });

  if (outcome.gone) {
    console.error('SESSION_OVER — the bridge stopped answering (the user closed the browser or the launcher exited). Stop looping and summarize what was done.');
    return 3;
  }
  if (outcome.timedOut) {
    console.log(`NO_BATCH_YET — no annotations arrived within ${timeoutSec}s. The session is still alive; run this exact command again to keep listening.`);
    return 4;
  }

  // 4. Print the batch + exactly what to do with it.
  const { batch } = outcome;
  console.log(`ANNOTATIONS_FILE=${batch.file}`);
  let data = null;
  try {
    data = JSON.parse(readFileSync(batch.file, 'utf8'));
  } catch (e) {
    console.error(`[agent] could not read the batch file (${e.message}) — read ANNOTATIONS_FILE yourself.`);
  }
  if (data) {
    console.log('----- BATCH JSON (also saved at ANNOTATIONS_FILE above) -----');
    console.log(JSON.stringify(data, null, 2));
    console.log('----- END BATCH JSON -----');
  }
  const resultsPath = path.join(dir, agent, 'results.json');
  console.log(`
WHAT TO DO NOW (${data?.annotations?.length ?? batch.count} annotation(s)):
1. ${data?.agentPrompt ? `Standing instructions from the user (apply to EVERY item): "${data.agentPrompt}"` : 'No standing instructions for this batch.'}
2. For each entry in annotations[]: edit the file at jsxSource ("file:line",
   already sourcemap-resolved — this is the exact edit target; read a small
   window around that line, do NOT explore the codebase) and make the change
   described in its "prompt". If jsxSource is empty, use componentChain[0].source.
   - annotations[].imagePath (imageKind "reference") = a reference image the
     USER pasted (mockup / external screenshot) — read it; NOT a page shot.
   - top-level screenshotPath (📷 toggle) = an actual full-page screenshot.
3. Need to SEE the page? Drive the browser (no user needed):
   node "${path.join(HERE, 'browse.mjs')}" shot --dir "${dir}" --annotation "${batch.file}" --id <id>   (crop an element)
   node "${path.join(HERE, 'browse.mjs')}" shot --dir "${dir}" --selector "<css>"   (or --full)
   node "${path.join(HERE, 'browse.mjs')}" open --dir "${dir}" --url <url>   (or: reload)
   'shot' prints SCREENSHOT=<path> — read that image; open/reload print PAGE_URL=<url>.
4. Write ${resultsPath} shaped like:
   { "message": "one-line headline",
     "items": [ { "id": <annotation id>, "status": "done|failed|skipped",
                  "summary": "plain words", "files": ["src/..."] } ] }
5. Report back so the user sees it in the browser — replace <YOUR-EXACT-MODEL>
   with the exact model id/name YOU are running as right now (e.g.
   claude-fable-5, gpt-5.2-codex, gemini-3-pro); never guess or omit it:
   node "${path.join(HERE, 'report.mjs')}" --dir "${dir}" --agent ${agent} --model <YOUR-EXACT-MODEL> --file "${resultsPath}"
6. Run this exact command again to wait for the next batch:
   node "${path.join(HERE, 'agent.mjs')}" --agent ${agent} --dir "${dir}" --url ${url}
   (exit 4 = just run it again; exit 3 = session over, stop.)`);
  return 0;
}

process.exitCode = await main();
