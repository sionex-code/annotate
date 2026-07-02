# Claude Annotator

Point at your running app, describe changes visually, and hand your AI coding
agent (Claude Code, and now also OpenCode, Codex, Antigravity, or "whatever
agent we install") the **exact component files** — no broad codebase reading,
far fewer tokens.

Two parts:

1. **`extension/`** — a Chrome (MV3) extension that runs on `localhost` pages.
   It adds a toolbar (bottom-right) with an element picker. For every element
   you click it captures:
   - your change request (the prompt you type),
   - the page URL,
   - a CSS selector + a snippet of the element's HTML/text,
   - the **React component chain** (walked via `_debugOwner`, supporting both
     client fibers and React Server Component info objects), and
   - **creation-site stack frames** (`_debugSource` on React ≤18,
     `_debugStack` on React 19).
2. **`launch.mjs`** — a Node script used by the `/annotate` Claude Code skill.
   It starts a tiny HTTP bridge on `localhost:4747`, launches Playwright's
   Chromium with the extension loaded, and opens your dev server. When you
   pick a target agent and click **Send**, `resolve.mjs` maps the
   compiled-chunk stack frames back to original files via sourcemaps (works
   with Turbopack and webpack dev builds, including React Server
   Components), producing exact targets like
   `src/components/site/search-box.tsx:66`. Each batch is written to
   `.claude-annotations/<agent>/inbox/<timestamp>.json` (+ `latest.json`) —
   one queue per agent, so more than one can run concurrently — and the
   session **keeps running**: annotate and send as many batches as you like;
   closing the browser ends it (`--once` restores the old single-shot
   behavior).

Around them, small helpers close the loop with whichever agent you send to:

- **`agents.mjs`** — the registry of agents that have installed this tool
  (`agents.json`, seeded with `claude` by default). `install.mjs` adds an
  entry when an agent installs itself; the extension reads `/agents` to
  populate its "Send to" dropdown.
- **`wait.mjs --agent <id>`** — blocks until the next batch addressed to
  `<id>` arrives, prints `ANNOTATIONS_FILE=...` and exits. Run it in the
  background and get woken up per batch, so new annotations are picked up
  automatically.
- **`report.mjs --agent <id>`** — posts a JSON summary of what the agent
  changed back to the bridge; the extension renders it in a **"✓ Changes
  applied"** panel on the page (per annotation: status, plain-words summary,
  files touched).
- **`bridge.mjs`** — the shared HTTP bridge used by `launch.mjs` and
  `server.mjs` (`/agents` registry, `/annotations` intake tagged by agent,
  `/wait?agent=` long-poll, `/results` reports). The active port is
  discoverable via `.claude-annotations/bridge.json`.

## Install (one command)

```sh
cd claude-annotator
node install.mjs            # installs deps + the /annotate skill for all projects (registers as "claude")
node install.mjs --project  # ...or into the current project's .claude/skills only
node install.mjs --agent codex --no-deps   # a different agent registering itself
```

The installer bakes this folder's current location into the skill, so you can
move or copy the directory anywhere (or to another machine) and just re-run it.
Add `--no-deps` to skip the npm / Playwright Chromium checks.

> **For Claude / AI agents:** to install this tool, run `node install.mjs`
> in this directory, then tell the user to restart Claude Code so the
> `/annotate` skill registers. Do not hand-copy `skill/SKILL.md` — it is a
> template with `{{ANNOTATOR_DIR}}` placeholders that the installer renders.
>
> **If you are a *different* coding agent** (OpenCode, Codex, Antigravity, or
> anything else) being pointed at this folder and asked to install it: read
> **[`AGENTS.md`](./AGENTS.md)** in this directory — it's a self-contained,
> agent-agnostic install + wait/implement/report loop written for exactly
> this situation (many agents, including OpenCode and Codex, auto-read
> `AGENTS.md` files, so it's the more reliable entry point than this prose).

> Branded Google Chrome ≥137 ignores `--load-extension`, which is why the
> launcher uses Playwright's Chromium build.

## Build / package the extension

```sh
npm run build                    # validate + package
node build.mjs --bump patch      # bump 1.0.0 -> 1.0.1 in manifest + package.json
```

The build validates the manifest, syntax-checks every referenced script, and
emits:

- `dist/unpacked/` — for `chrome://extensions` → "Load unpacked"
- `dist/claude-annotator-extension-v<version>.zip` — ready for the Chrome Web
  Store or sharing (a `.crx` is not produced; the Web Store repacks zips).

## Use with Claude Code

Run `/annotate` inside any project. Claude will:

1. Detect (or start) your dev server.
2. Run `launch.mjs` in the background and tell you the browser is ready.
3. Wait while you annotate: click **✛ Annotate**, click an element, type what
   should change, repeat for as many elements as you want, then pick **Claude**
   in the toolbar's agent dropdown (the default) and click **Send ➤**.
4. Read the resulting JSON, jump straight to the referenced component files,
   and implement each change.
5. Report what it changed back into the page — the **"✓ Changes applied"**
   panel lists each annotation's outcome (the ✓ toolbar button reopens it).
6. Keep waiting: the browser stays open and every new batch addressed to
   Claude is processed automatically until you close it.

If other agents have registered themselves (see the install section above),
the same dropdown lets you route a batch to them instead — each gets its own
queue, so switching targets never steals a batch meant for someone else.

## Use in your everyday Chrome (optional)

Load `extension/` (or `dist/unpacked/`) via `chrome://extensions` → Developer
mode → "Load unpacked", then start the standalone listener so **Send** has
somewhere to go:

```sh
npm run serve                 # persistent: collects every batch
node server.mjs --once        # exit after the first batch (legacy single-shot)
```

Each batch is sourcemap-resolved and written to
`.claude-annotations/<agent>/latest.json` plus `<agent>/inbox/<timestamp>.json`
(run it from your project directory, or pass `--out-dir`) — `<agent>` is
whichever target you picked in the dropdown. The persistent server supports
the same `wait.mjs`/`report.mjs` loop as the launcher, so the target agent
picks batches up automatically; otherwise ask it to "check my annotations".
Without any listener running, **Send** falls back to copying the JSON
payload to your clipboard so you can paste it into your agent manually.

## Notes

- Component names and source paths are only available on **dev builds**
  (production React strips debug info and minifies names).
- The annotation popup shows a friendly target (component name + text
  snippet); the technical details (selector, HTML, file:line) still travel in
  the payload for the target agent — they are just not displayed.
- The green dot in the toolbar means the bridge is reachable.
- The agent dropdown is populated from `agents.json` (via the bridge's
  `/agents` endpoint) and remembers your last pick per-port in localStorage.
- `Esc` exits picker mode; `Ctrl+Enter` saves the annotation form.
- Launcher flags: `--url`, `--dir`, `--out` (legacy), `--port`, `--headless`,
  `--once`.
- `wait.mjs`/`report.mjs` both take `--agent <id>` (default `claude`) to
  scope them to one agent's queue.
