// Registry of AI coding agents that have installed this tool — backs the
// extension's "Send to" dropdown. An agent shows up here after it (or
// whoever is running it) runs `node install.mjs --agent <id>`; see
// install.mjs and README.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_FILE = path.join(HERE, 'agents.json');

const DEFAULT_AGENTS = [{ id: 'claude', label: 'Claude' }];

const KNOWN_LABELS = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export function labelFor(id) {
  return KNOWN_LABELS[id.toLowerCase()] || id.charAt(0).toUpperCase() + id.slice(1);
}

function seedDefault() {
  const agents = DEFAULT_AGENTS.map((a) => ({ ...a, installedAt: new Date().toISOString() }));
  saveAgents(agents);
  return agents;
}

function saveAgents(agents) {
  writeFileSync(AGENTS_FILE, JSON.stringify({ agents }, null, 2) + '\n');
}

// Read the registry, seeding it with the default ("claude") entry the first
// time this runs so the dropdown is never empty out of the box.
export function loadAgents() {
  if (!existsSync(AGENTS_FILE)) return seedDefault();
  try {
    const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
    if (Array.isArray(data.agents) && data.agents.length) return data.agents;
    return seedDefault();
  } catch {
    return seedDefault();
  }
}

// Add a new agent or refresh an existing one's install timestamp/label.
export function registerAgent(id, label) {
  const agents = loadAgents();
  const existing = agents.find((a) => a.id === id);
  const installedAt = new Date().toISOString();
  if (existing) {
    existing.label = label;
    existing.installedAt = installedAt;
  } else {
    agents.push({ id, label, installedAt });
  }
  saveAgents(agents);
  return agents;
}
