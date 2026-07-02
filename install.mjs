#!/usr/bin/env node
// Installs the /annotate skill for Claude Code, pointing it at wherever this
// folder currently lives (so the whole directory can be moved or copied to
// another machine and re-installed with one command). Also registers the
// installing agent in agents.json so it appears in the extension's "Send to"
// dropdown — see registerAgent() in agents.mjs.
//
// Usage: node install.mjs [--project] [--no-deps] [--agent <id>]
//   --project   install into <cwd>/.claude/skills (this project only)
//               instead of ~/.claude/skills (all projects)
//   --no-deps   skip npm install / Playwright Chromium check
//   --agent     identity to register (default "claude"). If you are a
//               different AI coding agent (opencode, codex, antigravity, ...)
//               being asked to install this tool, pass your own name here —
//               e.g. `node install.mjs --agent codex` — so you show up in
//               the browser's "Send to" list under your own name. Only
//               "claude" gets the full /annotate skill below; other agents
//               are registered but consume batches via wait.mjs/report.mjs
//               directly (pass the same --agent id to both).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerAgent, labelFor, AGENTS_FILE } from './agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const project = argv.includes('--project');
const noDeps = argv.includes('--no-deps');
const agentFlagIdx = argv.indexOf('--agent');
const agentId = (agentFlagIdx !== -1 && argv[agentFlagIdx + 1] ? argv[agentFlagIdx + 1] : 'claude').toLowerCase();

// ---------------------------------------------------------------- deps

if (!noDeps) {
  if (!existsSync(path.join(HERE, 'node_modules', 'playwright'))) {
    console.log('[install] installing npm dependencies...');
    execSync('npm install', { cwd: HERE, stdio: 'inherit' });
  }
  console.log('[install] ensuring Playwright Chromium is available...');
  execSync('npx playwright install chromium', { cwd: HERE, stdio: 'inherit' });
}

// ---------------------------------------------------------------- skill

if (agentId === 'claude') {
  const skillsRoot = project
    ? path.join(process.cwd(), '.claude', 'skills')
    : path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(skillsRoot, 'annotate');

  const template = readFileSync(path.join(HERE, 'skill', 'SKILL.md'), 'utf8');
  const rendered = template.replaceAll('{{ANNOTATOR_DIR}}', HERE.replaceAll('\\', '/'));
  if (!rendered.includes(HERE.replaceAll('\\', '/'))) {
    console.error('[install] template rendering failed — {{ANNOTATOR_DIR}} not substituted');
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'SKILL.md'), rendered);

  console.log(`[install] skill installed: ${path.join(dest, 'SKILL.md')}`);
  console.log(`[install] launcher path baked in: ${HERE}`);
  console.log('[install] restart Claude Code (or open a new session) and run /annotate.');
} else {
  console.log(
    `[install] "${agentId}" doesn't have a dedicated skill/command wired up here yet — ` +
      `skipping that step. You can still consume annotation batches directly:`
  );
  console.log(`  node "${path.join(HERE, 'wait.mjs')}" --dir <project>/.claude-annotations --agent ${agentId}`);
  console.log(`  node "${path.join(HERE, 'report.mjs')}" --dir <project>/.claude-annotations --agent ${agentId} --file results.json`);
}

// ---------------------------------------------------------------- registry

registerAgent(agentId, labelFor(agentId));
console.log(`[install] registered "${agentId}" in ${AGENTS_FILE} — it will now appear in the extension's "Send to" list.`);
