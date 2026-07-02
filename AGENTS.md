# Claude Annotator — instructions for AI coding agents

You are being pointed at this folder because the user wants to install or use
the **Claude Annotator**: a Chrome extension + local bridge that lets them
click elements in their running app, describe changes, and hand your agent
the exact file:line to edit — no need to explore their codebase broadly.

This file is for **any** agent (OpenCode, Codex, Antigravity, Claude Code, or
anything else), not just Claude. Follow the steps below regardless of what
you are.

## 1. Install yourself

Run this from inside this directory:

```sh
node install.mjs --agent <your-name>
```

Replace `<your-name>` with your own product/tool name, lowercase, no spaces
— e.g. `opencode`, `codex`, `antigravity`, `claude`. This:

- installs npm dependencies + Playwright's Chromium (first run only; add
  `--no-deps` to skip if you know they're already installed),
- registers `<your-name>` in `agents.json`, so you appear as an option in the
  browser extension's **"Send to"** dropdown, labeled with your name,
- if (and only if) `<your-name>` is exactly `claude`, also installs a
  `/annotate` slash-command skill for Claude Code. For every other agent name
  there is no dedicated skill/command file yet — you consume batches
  directly via `wait.mjs`/`report.mjs` (step 4 below). If you have your own
  native mechanism for custom commands/skills, you can wrap step 4 in one,
  but it isn't required to work.

Confirm to the user that install succeeded and that you'll now show up in
the extension's dropdown as `<your-name>`.

## 2. Make sure the app's dev server is running

Check common ports (3000, 3001, 5173, 8080) for an already-running dev
server before starting a new one. If none is up, start the project's dev
script (check `package.json` for the exact one, usually `npm run dev`) —
**it must be detached/backgrounded**, since it never exits on its own. If
your shell tool has a native "run in background" option, use it. Otherwise:

- **Windows / PowerShell:** running `npm run dev` directly often fails with
  `cannot be loaded because running scripts is disabled` — call `npm.cmd`
  explicitly instead of `npm`. And a plain foreground call blocks your tool
  call until it's killed by a timeout, which kills the dev server with it —
  detach it instead:
  ```powershell
  Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" `
    -WorkingDirectory "<project>" -WindowStyle Hidden `
    -RedirectStandardOutput "<project>\.claude-annotations\dev.log" `
    -RedirectStandardError "<project>\.claude-annotations\dev.err.log"
  ```
- **macOS/Linux:** `nohup npm run dev > .claude-annotations/dev.log 2>&1 &`
  (or your shell tool's background flag).

After starting it, poll the port (don't assume it's ready immediately) until
it responds, then move on.

## 3. Get the browser + bridge running (if not already)

This has the same "must stay running after your tool call returns" property
as the dev server — detach it the same way (`Start-Process -WindowStyle
Hidden ...` on Windows, `nohup ... &` on macOS/Linux, or your shell tool's
background option). Someone needs to have started the bridge — either:

```sh
node launch.mjs --url <dev-server-url> --dir <project>/.claude-annotations
```

(opens a Playwright Chromium with the extension loaded), or, if the user
prefers their everyday Chrome with the extension loaded manually via
`chrome://extensions` → "Load unpacked" → `extension/`:

```sh
node server.mjs --out-dir <project>/.claude-annotations
```

Either way it prints `BRIDGE_PORT=<port>` and writes
`<project>/.claude-annotations/bridge.json`. If one is already running for
this project, skip this step.

## 4. Wait → implement → report loop

Once the user has annotated some elements, picked **your name** in the
toolbar dropdown, and clicked **Send**, batches addressed to you show up
here. Run in the background so you're woken up when one arrives:

```sh
node wait.mjs --dir <project>/.claude-annotations --agent <your-name>
```

- Exit code **0** — a batch arrived; its path is printed as
  `ANNOTATIONS_FILE=<path>`. Read that JSON.
- Exit code **3** — the bridge is gone (browser closed / launcher stopped).
  Session over.

For each entry in the file's `annotations[]` array:

- `prompt` — what the user wants changed.
- `jsxSource` — `file:line` of the exact JSX element (sourcemap-resolved).
  **This is the edit target.** If the file is large, read a small window
  around that line rather than the whole file — the line number is exact.
- `nearbyLabel` — optional hint: the nearest code comment above the target
  (e.g. `"Concentric Pulse Dot"`), to help you recognize the right block.
  It's a hint, not a guarantee — `jsxSource` is authoritative.
- `componentChain` — innermost-first owner components with their own
  `source` locations, in case `jsxSource` is empty.
- `selector`, `text`, `html` — extra detail to pinpoint the element.
- `url` — which page the user was on.

Implement each change directly in the referenced files — do not explore the
codebase broadly, the payload already tells you exactly where to look.

Then write a results file, e.g. `results.json`:

```json
{
  "message": "optional one-line headline",
  "items": [
    { "id": 1, "status": "done", "summary": "Increased hero heading to text-5xl",
      "files": ["src/app/page.tsx"] }
  ]
}
```

`id` matches the annotation's pin number; `status` is
`done | failed | skipped`. Deliver it:

```sh
node report.mjs --dir <project>/.claude-annotations --agent <your-name> --file results.json
```

This shows up in the page's "✓ Changes applied" panel. Then go back to the
`wait.mjs` step and keep looping until the user stops or the bridge exits.
