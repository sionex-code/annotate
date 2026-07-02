#!/usr/bin/env node
// Extension compiler/packager.
//
// Usage: node build.mjs [--bump patch|minor|major]
//
// 1. Optionally bumps the version (kept in sync across manifest.json and
//    package.json).
// 2. Validates the manifest and syntax-checks every referenced script.
// 3. Emits dist/unpacked/ (for chrome://extensions "Load unpacked") and
//    dist/claude-annotator-extension-v<version>.zip (Web Store / sharing).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, 'extension');
const DIST = path.join(HERE, 'dist');
const manifestPath = path.join(EXT_DIR, 'manifest.json');
const pkgPath = path.join(HERE, 'package.json');

const argv = process.argv.slice(2);
const bumpIdx = argv.indexOf('--bump');
const bump = bumpIdx !== -1 ? argv[bumpIdx + 1] : null;

// ---------------------------------------------------------------- version

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (bump) {
  const idx = { major: 0, minor: 1, patch: 2 }[bump];
  if (idx === undefined) {
    console.error(`[build] invalid --bump value "${bump}" (use patch|minor|major)`);
    process.exit(1);
  }
  const parts = manifest.version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  parts[idx]++;
  for (let i = idx + 1; i < 3; i++) parts[i] = 0;
  manifest.version = parts.join('.');
  pkg.version = manifest.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[build] bumped version to ${manifest.version}`);
} else if (pkg.version !== manifest.version) {
  pkg.version = manifest.version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[build] synced package.json version to ${manifest.version}`);
}

// ---------------------------------------------------------------- validate

const errors = [];
if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) errors.push(`manifest is missing "${key}"`);
}

const referenced = new Set();
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) referenced.add(f);
}
if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
for (const icon of Object.values(manifest.icons || {})) referenced.add(icon);
if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);

for (const f of referenced) {
  const p = path.join(EXT_DIR, f);
  if (!existsSync(p)) {
    errors.push(`referenced file missing: ${f}`);
    continue;
  }
  if (f.endsWith('.js') || f.endsWith('.mjs')) {
    try {
      execSync(`node --check "${p}"`, { stdio: 'pipe' });
    } catch (e) {
      errors.push(`syntax error in ${f}:\n${e.stderr}`);
    }
  }
}

if (errors.length) {
  console.error('[build] FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`[build] manifest ok, ${referenced.size} referenced file(s) validated`);

// ---------------------------------------------------------------- package

const unpacked = path.join(DIST, 'unpacked');
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
cpSync(EXT_DIR, unpacked, { recursive: true });

const zipPath = path.join(DIST, `claude-annotator-extension-v${manifest.version}.zip`);
rmSync(zipPath, { force: true });
if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'pipe' }
  );
} else {
  execSync(`zip -r "${zipPath}" .`, { cwd: unpacked, stdio: 'pipe' });
}

const kb = (statSync(zipPath).size / 1024).toFixed(1);
console.log(`[build] dist/unpacked/ ready (Load unpacked in chrome://extensions)`);
console.log(`[build] ${path.relative(HERE, zipPath)} (${kb} KB)`);
