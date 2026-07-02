// Shared HTTP bridge for the Claude Annotator.
// Serves the browser extension (annotation intake + applied-change reports)
// and the per-agent helpers (wait.mjs long-poll, report.mjs result posting).
//
// Endpoints:
//   GET  /ping                 liveness (extension green dot)
//   GET  /agents                registered agents for the "Send to" dropdown
//   POST /annotations          extension sends a batch (tagged `agent`) -> onBatch(data) writes it
//   GET  /wait?agent=X         long-poll: responds with the next unclaimed batch for that agent
//   POST /results              agent posts what it changed (optionally tagged `agent`)
//   GET  /results?since=N      extension polls for reports newer than N (all agents)
//   GET  /state                debug snapshot
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadAgents } from './agents.mjs';

const MAX_RESULTS = 50;
// Unclaimed-batch caps: new POSTs are rejected with 429 { error: "queue_full" }
// rather than silently dropping queued work.
export const MAX_QUEUED_PER_AGENT = 10;
export const MAX_QUEUED_TOTAL = 50;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// onBatch(data) -> file path the batch was written to (may be async).
// `dir` is the bridge's output directory; when given, agent-seen state is
// persisted to <dir>/agents.json so it survives bridge restarts.
export function createBridge({ onBatch, log = console.log, dir = null }) {
  const batches = []; // { n, file, count, url, agent, claimed }
  const results = []; // { id, at, agent, message, items }
  let batchSeq = 0;
  let resultSeq = 0;
  const waiters = new Set(); // parked /wait responses: { res, agent }
  const agentSeen = new Map(); // agent id -> last time it hit /wait or /results
  let bridgePort = null; // filled in once the server is listening

  const seenFile = dir ? path.join(dir, 'agents.json') : null;
  if (seenFile && existsSync(seenFile)) {
    try {
      const saved = JSON.parse(readFileSync(seenFile, 'utf8'));
      for (const [a, iso] of Object.entries(saved.seen || {})) {
        const t = Date.parse(iso);
        if (Number.isFinite(t)) agentSeen.set(a, t);
      }
    } catch {}
  }

  function persistSeen() {
    if (!seenFile) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        seenFile,
        JSON.stringify(
          {
            port: bridgePort,
            agents: loadAgents(),
            seen: Object.fromEntries([...agentSeen].map(([a, t]) => [a, new Date(t).toISOString()])),
          },
          null,
          2
        )
      );
    } catch (e) {
      log(`[bridge] could not persist agent state to ${seenFile}: ${e.message}`);
    }
  }

  function markSeen(agent) {
    agentSeen.set(agent, Date.now());
    persistSeen();
  }

  // Try to satisfy every parked waiter with the oldest unclaimed batch
  // addressed to its agent (skip dead connections without claiming, so an
  // aborted long-poll never swallows a batch meant for someone else).
  function deliverNext() {
    for (const w of waiters) {
      if (w.res.destroyed || w.res.writableEnded) {
        waiters.delete(w);
        continue;
      }
      const next = batches.find((b) => !b.claimed && b.agent === w.agent);
      if (!next) continue;
      next.claimed = true;
      waiters.delete(w);
      json(w.res, 200, { n: next.n, file: next.file, count: next.count, url: next.url });
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200);
      return res.end('ok');
    }

    if (req.method === 'GET' && url.pathname === '/agents') {
      return json(res, 200, { agents: loadAgents() });
    }

    if (req.method === 'POST' && url.pathname === '/annotations') {
      try {
        const data = JSON.parse(await readBody(req));
        const agent = typeof data.agent === 'string' && data.agent ? data.agent : 'claude';
        // Reject when the unclaimed queue is full (per agent or bridge-wide)
        // instead of piling up batches nobody is draining.
        const queuedForAgent = batches.filter((b) => !b.claimed && b.agent === agent).length;
        const queuedTotal = batches.filter((b) => !b.claimed).length;
        if (queuedForAgent >= MAX_QUEUED_PER_AGENT || queuedTotal >= MAX_QUEUED_TOTAL) {
          const perAgent = queuedForAgent >= MAX_QUEUED_PER_AGENT;
          log(`[bridge] queue full (${perAgent ? `${queuedForAgent} unclaimed for "${agent}"` : `${queuedTotal} unclaimed total`}) — rejecting batch`);
          return json(res, 429, {
            error: 'queue_full',
            scope: perAgent ? 'agent' : 'total',
            queued: perAgent ? queuedForAgent : queuedTotal,
            cap: perAgent ? MAX_QUEUED_PER_AGENT : MAX_QUEUED_TOTAL,
          });
        }
        // Tell the extension whether anyone will actually act on this batch:
        // `waiting` = a /wait long-poll for this agent is parked right now,
        // `seen` = this agent has connected to this bridge before (persisted
        // across restarts; it's likely mid-loop and will re-poll), with
        // `lastSeenAt` saying when. Neither -> the extension warns the user
        // instead of showing a plain success toast.
        const waiting = [...waiters].some((w) => w.agent === agent && !w.res.destroyed && !w.res.writableEnded);
        const lastSeen = agentSeen.get(agent);
        json(res, 200, {
          ok: true,
          waiting,
          seen: lastSeen !== undefined,
          lastSeenAt: lastSeen !== undefined ? new Date(lastSeen).toISOString() : null,
          dir,
        }); // ack fast; resolve/write async
        let file = null;
        try {
          file = await onBatch(data, agent);
        } catch (e) {
          log(`[bridge] batch handling failed: ${e.message}`);
        }
        batches.push({
          n: ++batchSeq,
          file,
          count: data.annotations?.length ?? 0,
          url: data.url ?? null,
          agent,
          claimed: false,
        });
        deliverNext();
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/wait') {
      const agent = url.searchParams.get('agent') || 'claude';
      markSeen(agent);
      const waiter = { res, agent };
      waiters.add(waiter);
      req.on('close', () => waiters.delete(waiter));
      deliverNext(); // an unclaimed batch may already be pending
      return;
    }

    if (req.method === 'POST' && url.pathname === '/results') {
      try {
        const data = JSON.parse(await readBody(req));
        const entry = {
          id: ++resultSeq,
          at: new Date().toISOString(),
          agent: typeof data.agent === 'string' && data.agent ? data.agent : null,
          message: typeof data.message === 'string' ? data.message : null,
          items: Array.isArray(data.items) ? data.items : [],
        };
        results.push(entry);
        if (entry.agent) markSeen(entry.agent);
        if (results.length > MAX_RESULTS) results.splice(0, results.length - MAX_RESULTS);
        json(res, 200, { ok: true, id: entry.id });
        log(`[bridge] report #${entry.id}${entry.agent ? ` (${entry.agent})` : ''}: ${entry.items.length} item(s)${entry.message ? ` — ${entry.message}` : ''}`);
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/results') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, 200, { latest: resultSeq, results: results.filter((r) => r.id > since) });
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, {
        dir,
        port: bridgePort,
        batches: batchSeq,
        unclaimed: batches.filter((b) => !b.claimed).length,
        results: resultSeq,
        waiters: waiters.size,
        agentsSeen: Object.fromEntries([...agentSeen].map(([a, t]) => [a, new Date(t).toISOString()])),
      });
    }

    res.writeHead(404);
    res.end();
  });

  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') bridgePort = addr.port;
    persistSeen(); // record this bridge's port alongside any restored seen-state
  });

  return server;
}

// Listen on basePort, walking up if taken. Resolves the bound port.
export function listenOnFreePort(server, basePort, tries = 10) {
  return new Promise((resolve, reject) => {
    let port = basePort;
    let attempts = 1;
    const onError = (e) => {
      if (e.code === 'EADDRINUSE' && attempts++ < tries) server.listen(++port);
      else reject(e);
    };
    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
    server.listen(port);
  });
}

// Write a batch to <dir>/<agent>/inbox/<timestamp>.json and
// <dir>/<agent>/latest.json — each agent gets its own queue so multiple
// agents can run wait.mjs concurrently without stealing each other's batches.
// Images the user pasted into annotations arrive as data URLs; they are
// written to <dir>/<agent>/shots/ and replaced with an `imagePath` the
// consuming agent can open directly.
export function writeBatch(data, dir, agent = 'claude') {
  const agentDir = path.join(dir, agent);
  mkdirSync(path.join(agentDir, 'inbox'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const a of data.annotations || []) {
    const m =
      typeof a.pastedImage === 'string' &&
      a.pastedImage.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/s);
    if (m) {
      const shotsDir = path.join(agentDir, 'shots');
      mkdirSync(shotsDir, { recursive: true });
      const imgFile = path.join(shotsDir, `${stamp}-a${a.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      writeFileSync(imgFile, Buffer.from(m[2], 'base64'));
      a.imagePath = imgFile;
    }
    delete a.pastedImage;
  }
  const file = path.join(agentDir, 'inbox', `${stamp}.json`);
  const body = JSON.stringify(data, null, 2);
  writeFileSync(file, body);
  writeFileSync(path.join(agentDir, 'latest.json'), body);
  return file;
}

// bridge.json lets wait.mjs / report.mjs discover the running bridge's port.
export function writeBridgeInfo(dir, info) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ ...info, pid: process.pid }, null, 2));
}

export function clearBridgeInfo(dir) {
  try {
    rmSync(path.join(dir, 'bridge.json'), { force: true });
  } catch {}
}
