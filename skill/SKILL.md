---
name: annotate
description: Visual UI feedback workflow. Launches the current project in Chromium (via Playwright) with the Claude Annotator extension so the user can click elements, attach change requests, and send them back with exact React component paths and source files. Stays running — batches are processed as they arrive and applied changes are reported back into the browser. Use when the user wants to visually point at UI to request changes ("/annotate", "let me show you in the browser", "I want to mark up the page").
---

# Annotate — visual element feedback (persistent session)

The launcher and extension live in `{{ANNOTATOR_DIR}}`.
The whole point of this skill is **token efficiency**: the payload you receive
identifies the exact component files, so you must NOT explore the codebase
broadly — go straight to the referenced files.

The session is a **loop**: launch once, then repeatedly wait → implement →
report, until the user closes the browser or says to stop.

## 1. Find the dev server

Check if the project is already serving (try ports 3000, 3001, 5173, 8080 —
e.g. `Test-NetConnection localhost -Port 3000`). If nothing is running, start
the project's dev script **in the background** and wait for it to be ready
(poll the port — don't assume it's up immediately). Ask the user for the URL
only if you cannot determine it.

If your tool has a native "run in background" flag (e.g. Claude Code's Bash
tool `run_in_background: true`), use that. If not — notably on Windows
PowerShell, where a plain `npm run dev` call (a) often fails with `cannot be
loaded because running scripts is disabled` (call `npm.cmd` explicitly
instead of `npm`) and (b) blocks in the foreground until your tool call times
out, which kills the dev server with it — detach it explicitly instead:

```powershell
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" `
  -WorkingDirectory "<PROJECT_DIR>" -WindowStyle Hidden `
  -RedirectStandardOutput "<PROJECT_DIR>\.claude-annotations\dev.log" `
  -RedirectStandardError "<PROJECT_DIR>\.claude-annotations\dev.err.log"
```

(macOS/Linux equivalent: `nohup npm run dev > .claude-annotations/dev.log 2>&1 &`.)

## 2. Launch the annotator (once)

With the Bash tool, `run_in_background: true` (or your tool's equivalent —
see the detached-process note in step 1; `launch.mjs` never exits on its own
either, so it needs the same treatment):

```sh
node "{{ANNOTATOR_DIR}}/launch.mjs" --url <DEV_URL> --dir "<PROJECT_DIR>/.claude-annotations"
```

The launcher is **persistent**: it keeps the browser and bridge alive for the
whole session and accepts any number of batches. It prints
`BRIDGE_PORT=<port>` and writes `<dir>/bridge.json` (used by the helper
scripts below), and it only exits when the browser is closed (exit 0 if
batches were received, 2 if none) — that exit means the session is over,
with ONE exception: if it prints `ALREADY_RUNNING=1`, an annotator session
for this project is already live (possibly started by another agent) and is
being **reused** — the immediate exit does NOT mean the session ended. Never
try to launch again; just continue to step 3.
If it fails because Chromium is missing, run
`npx --prefix "{{ANNOTATOR_DIR}}" playwright install chromium` and retry.

Tell the user it is ready:
- Click **✛ Annotate** in the bottom-right toolbar, click any element.
- Type what should change, Save (`Ctrl+Enter`). Repeat for multiple elements.
- Make sure **Claude** is selected in the toolbar's agent dropdown, then click
  **Send ➤** — they can keep annotating and sending more batches at any
  time; each one addressed to Claude is picked up automatically.

## 3. Wait for the next batch

Run in the background (Bash tool, `run_in_background: true`) and then stop —
you are re-invoked when it exits, do not poll:

```sh
node "{{ANNOTATOR_DIR}}/wait.mjs" --dir "<PROJECT_DIR>/.claude-annotations" --agent claude
```

Exit codes:
- **0** — a batch arrived; its path is printed as `ANNOTATIONS_FILE=...`.
  Continue with step 4.
- **3** — the bridge is gone (user closed the browser / launcher stopped).
  The session is over: give a final summary and stop looping.

## 4. Process the annotations

Read the `ANNOTATIONS_FILE` JSON. If the top level has an `agentPrompt`
string, those are the user's saved standing instructions for Claude (set via
the extension's ⚙ panel) — apply them to **every** annotation in the batch.
For each entry in `annotations[]`:

- `prompt` — what the user wants changed for that element.
- `jsxSource` — file:line of the clicked element's JSX (sourcemap-resolved,
  e.g. `src/components/site/search-box.tsx:66`). **This is the edit
  target.** If the file is large (a big page/route file with many sections
  inline), read a small window around that line (e.g. ~20 lines before/after)
  instead of the whole file — the line number is exact, so you rarely need
  more context than that.
- `nearbyLabel` — an optional best-effort hint (the nearest code comment
  above the target, e.g. `"Concentric Pulse Dot"`) to help you recognize the
  right block at a glance in a large file. It's a hint, not a guarantee —
  `jsxSource`'s line number is the authoritative target.
- `componentChain` — innermost-first `{name, source}` owner components
  (e.g. SearchBox → Header → RootLayout); `source` is where that component
  is *used*. `sources` is the deduplicated list of all of the above.
- If `jsxSource`/`sources` are empty, Grep the first one or two
  `componentChain` names to locate the file — do not read unrelated files
  or list directories.
- `selector`, `text`, `html` — to pinpoint the exact JSX inside the file.
- `url` — which route/page the user was on.
- `imagePath` (optional) — absolute path of a **reference image the user
  pasted onto this annotation** (`imageKind: "reference"`), e.g. a design
  mockup or an external screenshot. This is the user's supplied reference —
  it is **NOT** a screenshot of the current page. Read the image file to see
  what they want. Always sent when present, regardless of the 📷 toggle.
- Top-level `screenshotPath` (optional, only when the user's 📷 page-screenshot
  toggle is on) — absolute path of an actual **full-page screenshot of the
  app** taken when the batch was sent; each annotation's `rect` gives its page
  coordinates within it. Read it when the prompts need visual context; skip it
  when the text is already unambiguous.

### Need to SEE the page? Drive the browser yourself

You don't have to wait for the user — you can control the same Playwright
browser directly (via `browse.mjs`) to get exactly the pixels you need:

```sh
# a tight crop of one annotation's element (uses its selector — always in frame)
node "{{ANNOTATOR_DIR}}/browse.mjs" shot --dir "<PROJECT_DIR>/.claude-annotations" --annotation <ANNOTATIONS_FILE> --id <annotation id>
node "{{ANNOTATOR_DIR}}/browse.mjs" shot --dir "..." --selector "<css selector>"   # any element
node "{{ANNOTATOR_DIR}}/browse.mjs" shot --dir "..." --full                        # whole page
node "{{ANNOTATOR_DIR}}/browse.mjs" open --dir "..." --url <url>                    # go to another route
node "{{ANNOTATOR_DIR}}/browse.mjs" reload --dir "..."                              # reload after edits
```

`shot` prints `SCREENSHOT=<path>` — read that image file. `open`/`reload`
print `PAGE_URL=<url>`. This is the fast way to verify a change landed, inspect
an exact area referenced in a prompt, or move to the page an annotation is
about. (Only works with the Playwright launcher, not a hand-loaded extension.)

Implement each annotation's change, respecting this project's agent
delegation policy if one exists (e.g. frontend work may need to go through a
designated subagent — pass the annotation payload verbatim in the prompt).

## 5. Report the applied changes back to the browser

The user is looking at the page, not the terminal — after implementing a
batch, show them what happened. Write a results file (e.g.
`<PROJECT_DIR>/.claude-annotations/results/<timestamp>.json`):

```json
{
  "message": "optional one-line headline",
  "items": [
    { "id": 1, "status": "done", "summary": "Increased hero heading to text-5xl",
      "files": ["src/app/page.tsx"] },
    { "id": 2, "status": "failed", "summary": "Could not locate the legacy footer link" }
  ]
}
```

`id` matches the annotation number (its red pin), `status` is
`done | failed | skipped`, `summary` is plain words (no HTML/code dumps),
`files` lists the files touched. Then deliver it — `--model` must be **your
exact model id** as stated in your system prompt (e.g. `claude-fable-5`),
never a guess or a family name:

```sh
node "{{ANNOTATOR_DIR}}/report.mjs" --dir "<PROJECT_DIR>/.claude-annotations" --agent claude --model <your-exact-model-id> --file <results file>
```

The extension shows it in a "✓ Changes applied" panel on the page, attributed
to your agent + model (the dev server hot-reloads the visual changes
themselves). Also summarize the same things in chat, per annotation number.

## 6. Loop

Go back to **step 3** (start `wait.mjs` in the background again) and keep
accepting new batches automatically. Do not end the session yourself unless
the user asks, `wait.mjs` exits 3, or the launcher background task exits.

## Alternative: user's own browser (no Playwright)

If the user prefers annotating in their everyday Chrome (extension loaded
unpacked from `{{ANNOTATOR_DIR}}/extension`), skip the Playwright launch and
run the standalone bridge in the background instead:

```sh
node "{{ANNOTATOR_DIR}}/server.mjs" --out-dir "<PROJECT_DIR>/.claude-annotations"
```

It is persistent too and supports the same `wait.mjs`/`report.mjs` loop
(steps 3-6). Add `--once` for the legacy single-batch mode (exits after the
first send). If the user says "check my annotations", read
`.claude-annotations/claude/latest.json` (or unprocessed `claude/inbox/`
files) and continue from step 4.
