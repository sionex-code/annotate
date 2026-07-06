# Claude Annotator — instructions for AI coding agents

You are being pointed at this folder because the user wants to install or use
the **Claude Annotator**: a Chrome extension + local bridge that lets them
click elements in their running app, describe changes, and hand you the exact
`file:line` to edit — no broad codebase exploration needed.

This file is for **any** agent (OpenCode, Codex, Antigravity, Claude Code, or
anything else). The whole workflow is **one repeatable command**; you never
need to manage the browser, ports, or queues yourself.

## 1. Install yourself (once)

From inside this directory:

```sh
node install.mjs --agent <your-name>
```

`<your-name>` is your own product/tool name, lowercase, no spaces — e.g.
`opencode`, `codex`, `antigravity`, `claude`. This installs npm deps +
Playwright Chromium (add `--no-deps` to skip), registers you in the browser
extension's **"Send to"** dropdown, and installs an `/annotate` skill for you:
Claude Code gets `~/.claude/skills/annotate`, OpenCode gets
`~/.config/opencode/command/annotate.md` (or `.opencode/command/` with
`--project`), Codex gets `~/.codex/prompts/annotate.md`, anything else gets
`agents/<your-name>-annotate.md` in this folder to wire into your own
command mechanism. Tell the user install succeeded and that you now appear in
the extension's dropdown.

## 2. Make sure the app's dev server is running

Check common ports (3000, 3001, 5173, 8080) for an already-running dev server
before starting one. If none is up, start the project's dev script
**detached/backgrounded** (a foreground call gets killed with your tool call,
killing the server too). On Windows PowerShell call `npm.cmd`, not `npm`:

```powershell
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" -WorkingDirectory "<project>" -WindowStyle Hidden
```

(macOS/Linux: `nohup npm run dev > /dev/null 2>&1 &`.) Poll the port until it
answers before moving on.

## 3. The loop — one command, run it in the foreground

```sh
node agent.mjs --agent <your-name> --dir <project>/.claude-annotations --url <dev-server-url>
```

Every run of this command, by itself: registers you, **reuses** the running
annotator browser for this project if there is one (it never spawns a second
browser — even if another agent started it), launches it otherwise, then waits
up to 90s for the next batch addressed to you. It always exits on its own, so
it is safe to run in the foreground. Branch only on the result:

- **exit 0** — it printed `ANNOTATIONS_FILE=...`, the batch JSON, and a
  **WHAT TO DO NOW** checklist. Follow the checklist literally:
  - `agentPrompt` (if present) = the user's standing instructions for you —
    apply to every annotation.
  - each `annotations[].jsxSource` (`file:line`) is the exact edit target for
    that annotation's `prompt`; read a small window around the line only.
  - write the results JSON and deliver it with the printed `report.mjs`
    command, passing `--model` with **your exact model id/name** (the model
    you are running as right now — never guess, never omit). The report shows
    up inside the user's browser, attributed to you.
- **exit 4** (`NO_BATCH_YET`) — nothing arrived yet; nothing is wrong. Run the
  **same command** again.
- **exit 3** (`SESSION_OVER` / `DEV_SERVER_NOT_RUNNING`) — do what the message
  says; if the session is over, stop looping and summarize what you did.

Then run the command again — keep looping until exit 3 or the user says stop.

## Advanced (only if you cannot use agent.mjs)

`agent.mjs` wraps these lower-level helpers, which take the same `--dir` and
`--agent` flags: `launch.mjs` (browser + bridge; prints `ALREADY_RUNNING=1`
and exits if one is already up for the project — that is reuse, not a
failure), `server.mjs` (bridge only, for a hand-loaded extension),
`wait.mjs [--timeout <sec>]` (block until the next batch; exit 0 = batch,
4 = timeout, 3 = session over), and `report.mjs --file results.json
--model <your-model>` (deliver the applied-changes report). See README.md.

To **see the page yourself** (crop an exact area, navigate, reload after
edits) drive the launcher's browser with `browse.mjs`:
`node browse.mjs shot --dir <dir> --annotation <batch.json> --id <n>` (or
`--selector "<css>"` / `--rect x,y,w,h` / `--full`) prints `SCREENSHOT=<path>`
to read; `node browse.mjs open --dir <dir> --url <url>` and
`node browse.mjs reload --dir <dir>` print `PAGE_URL=<url>`. A batch's
`annotations[].imagePath` (`imageKind: "reference"`) is a user-pasted
reference image, distinct from the top-level `screenshotPath` page screenshot.
