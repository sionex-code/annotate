// Shared client-side helpers for talking to a running bridge — used by
// wait.mjs, agent.mjs and the launchers' "is one already running?" checks.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// <dir>/bridge.json is written by launch.mjs / server.mjs on startup and
// removed on clean shutdown. Returns null when missing/unreadable.
export function readBridgeInfo(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'bridge.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function pingBridge(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://localhost:${port}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// Confirm a bridge on `port` is alive AND serving `dir` — a port can be
// recycled by another project's bridge, in which case its batches would go
// to the wrong place. Returns the bridge's /state snapshot, or null.
export async function bridgeStateFor(port, dir, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://localhost:${port}/state`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const state = await res.json();
    if (state.dir && path.resolve(state.dir) !== path.resolve(dir)) return null;
    return state;
  } catch {
    return null;
  }
}

// The live bridge for `dir` (port + state), or null. This is THE check that
// keeps every entry point from spawning a second bridge/browser per project.
export async function findRunningBridge(dir) {
  const info = readBridgeInfo(dir);
  if (!info || !info.port) return null;
  const state = await bridgeStateFor(info.port, dir);
  return state ? { ...info, state } : null;
}

// Drive the annotator browser through the bridge (screenshot / navigate /
// reload). Resolves { status, ok, data }; `data.path` is a saved screenshot,
// `data.url` the page's url after the command. Only a launcher bridge can
// fulfill these — a browser-less bridge answers 501.
export async function sendCommand(port, body, timeoutMs = 30000) {
  const res = await fetch(`http://localhost:${port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// Long-poll the bridge for the next batch addressed to `agent`.
// Resolves { batch } on delivery, { timedOut: true } when timeoutMs elapses
// (the batch queue is untouched — just call again), or { gone: true } when
// the bridge stops answering (session over).
export async function waitForBatch({ port, agent, timeoutMs = 0 }) {
  const base = `http://localhost:${port}`;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let downChecks = 0;
  for (;;) {
    const remaining = deadline ? deadline - Date.now() : null;
    if (remaining !== null && remaining <= 0) return { timedOut: true };
    try {
      const res = await fetch(
        `${base}/wait?agent=${encodeURIComponent(agent)}`,
        remaining !== null ? { signal: AbortSignal.timeout(remaining) } : undefined
      );
      if (res.ok) return { batch: await res.json() };
      downChecks = 0; // reachable but odd status — just retry
    } catch {
      if (deadline && Date.now() >= deadline) return { timedOut: true };
      // Long-poll aborted (undici's ~5 min header timeout) or bridge gone — probe.
      if (await pingBridge(port)) downChecks = 0;
      else if (++downChecks >= 3) return { gone: true };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
