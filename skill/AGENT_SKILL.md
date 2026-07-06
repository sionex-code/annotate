---
description: Visual UI feedback loop — the user clicks elements in their running app in the browser and describes changes; you receive the exact file:line targets, apply the edits, and report back into the page. Use when the user says /annotate, "let me show you in the browser", or wants to point at UI.
---

# Annotate — visual UI feedback loop (for {{AGENT_LABEL}})

The user annotates elements in the browser; every batch you receive already
contains the **exact file:line to edit**. Do NOT explore the codebase — go
straight to the referenced lines.

The whole workflow is **one repeating command**. Before starting, substitute:

- `<PROJECT>` — absolute path of the project you are working in
- `<DEV_URL>` — the project's dev-server URL (e.g. `http://localhost:3000`)

## 0. Dev server first

The project's dev server must be running at `<DEV_URL>`. If it is not, start
it **detached/backgrounded** (a foreground call would be killed with your tool
call, killing the server). On Windows PowerShell use `npm.cmd`, e.g.:

```powershell
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" -WorkingDirectory "<PROJECT>" -WindowStyle Hidden
```

(macOS/Linux: `nohup npm run dev > /dev/null 2>&1 &`.) Then poll the URL until
it answers.

## 1. Run the loop command

Run this in the **foreground** — it always exits on its own within ~90s, so it
cannot hang your tool call:

```sh
node "{{ANNOTATOR_DIR}}/agent.mjs" --agent {{AGENT_ID}} --dir "<PROJECT>/.claude-annotations" --url <DEV_URL>
```

It reuses the already-open annotator browser if there is one (it will **never**
open a second browser), otherwise it opens one. The first time, tell the user:
"Browser is ready — click ✛ Annotate, click an element, describe the change,
then pick **{{AGENT_LABEL}}** in the dropdown and click **Send ➤**."

## 2. Branch ONLY on what it printed / its exit code

- **exit 0** (`ANNOTATIONS_FILE=...` + JSON printed) → go to step 3.
- **exit 4** (`NO_BATCH_YET`) → nothing arrived yet, nothing is wrong. Run the
  **same command** again (step 1). Never re-launch anything else.
- **exit 3** (`SESSION_OVER` / `DEV_SERVER_NOT_RUNNING` / error) → do what the
  message says. If the session is over, stop looping and summarize what you did.

## 3. Implement the batch

The command prints the batch JSON and a **WHAT TO DO NOW** checklist with the
exact report command — follow it literally. The rules that matter:

- `agentPrompt` (if present) = the user's standing instructions — apply them to
  **every** annotation in the batch.
- For each `annotations[]` entry: `prompt` is the requested change and
  `jsxSource` (`file:line`, sourcemap-resolved) is the **exact edit target** —
  read a small window around that line, not the whole file. Fall back to
  `componentChain[0].source` only if `jsxSource` is empty.
- `imagePath` (if present, `imageKind: "reference"`) = a **reference image the
  user pasted** onto that annotation (a mockup / external screenshot) — read
  it; it is NOT a screenshot of the page. Top-level `screenshotPath` (only with
  the 📷 toggle) = an actual full-page screenshot of the app.
- After editing, write the results JSON and deliver it with the printed
  `report.mjs` command, passing `--model` with **your own exact model id/name**
  (the model you are running as right now — never guess, never omit). The user
  sees this report inside the browser.

## 3b. See the page yourself (optional, no user needed)

Drive the same browser to grab exactly the pixels you need — a crop of an
annotated element, another route, or a reload to verify a change:

```sh
node "{{ANNOTATOR_DIR}}/browse.mjs" shot --dir "<PROJECT>/.claude-annotations" --annotation <ANNOTATIONS_FILE> --id <id>
node "{{ANNOTATOR_DIR}}/browse.mjs" shot --dir "..." --selector "<css>"   # or --full
node "{{ANNOTATOR_DIR}}/browse.mjs" open --dir "..." --url <url>          # or: reload
```

`shot` prints `SCREENSHOT=<path>` (read that image); `open`/`reload` print
`PAGE_URL=<url>`. Needs the Playwright launcher (not a hand-loaded extension).

## 4. Loop

Run step 1 again and keep going until exit 3 or the user tells you to stop.
