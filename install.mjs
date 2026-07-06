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
//               the browser's "Send to" list under your own name. Every agent
//               gets an /annotate skill: "claude" gets skill/SKILL.md, all
//               others get skill/AGENT_SKILL.md rendered into their native
//               custom-command location (OpenCode/Codex) or agents/<id>.md
//               here, built around the one-command loop `agent.mjs`.
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

function renderTemplate(file, agentId) {
  const rendered = readFileSync(path.join(HERE, 'skill', file), 'utf8')
    .replaceAll('{{ANNOTATOR_DIR}}', HERE.replaceAll('\\', '/'))
    .replaceAll('{{AGENT_ID}}', agentId)
    .replaceAll('{{AGENT_LABEL}}', labelFor(agentId));
  if (!rendered.includes(HERE.replaceAll('\\', '/'))) {
    console.error(`[install] template rendering failed — {{ANNOTATOR_DIR}} not substituted in ${file}`);
    process.exit(1);
  }
  return rendered;
}

if (agentId === 'claude') {
  const skillsRoot = project
    ? path.join(process.cwd(), '.claude', 'skills')
    : path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(skillsRoot, 'annotate');

  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'SKILL.md'), renderTemplate('SKILL.md', agentId));

  console.log(`[install] skill installed: ${path.join(dest, 'SKILL.md')}`);
  console.log(`[install] launcher path baked in: ${HERE}`);
  console.log('[install] restart Claude Code (or open a new session) and run /annotate.');
} else {
  // Every other agent gets the generic one-command skill (agent.mjs loop),
  // written into its native custom-command location when we know it.
  const home = os.homedir();
  const dests =
    agentId === 'opencode'
      ? [
          project
            ? path.join(process.cwd(), '.opencode', 'command', 'annotate.md')
            : path.join(home, '.config', 'opencode', 'command', 'annotate.md'),
        ]
      : agentId === 'codex'
        ? [path.join(home, '.codex', 'prompts', 'annotate.md')]
        : [path.join(HERE, 'agents', `${agentId}-annotate.md`)];

  const rendered = renderTemplate('AGENT_SKILL.md', agentId);
  for (const dest of dests) {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, rendered);
    console.log(`[install] skill installed: ${dest}`);
  }
  if (agentId === 'opencode' || agentId === 'codex') {
    console.log(`[install] restart ${labelFor(agentId)} and run /annotate.`);
  } else {
    console.log(`[install] wire that file into ${labelFor(agentId)}'s custom command/skill mechanism (or just follow it directly).`);
  }
  console.log('[install] the whole loop is one repeatable command:');
  console.log(`  node "${path.join(HERE, 'agent.mjs')}" --agent ${agentId} --dir <project>/.claude-annotations --url <dev-url>`);
}

// ---------------------------------------------------------------- registry

registerAgent(agentId, labelFor(agentId));
console.log(`[install] registered "${agentId}" in ${AGENTS_FILE} — it will now appear in the extension's "Send to" list.`);
