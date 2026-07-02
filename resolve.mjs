// Resolves compiled-chunk stack frames captured by the extension back to
// original source files, using the dev server's sourcemaps (client chunks)
// and on-disk sourcemaps (Next.js RSC/SSR chunks referenced via about:// URLs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';

const RSC_PREFIX = 'about://React/Server/';
const mapCache = new Map();

function parseDataUri(ref) {
  return JSON.parse(Buffer.from(ref.slice(ref.indexOf(',') + 1), 'base64').toString('utf8'));
}

async function sourceMapFor(url) {
  const key = url.split('?')[0];
  if (mapCache.has(key)) return mapCache.get(key);
  let sm = null;
  try {
    let js;
    let loadRef;
    let defaultRef;
    if (key.startsWith(RSC_PREFIX)) {
      const file = decodeURIComponent(key.slice(RSC_PREFIX.length));
      js = readFileSync(file, 'utf8');
      defaultRef = `${file}.map`;
      loadRef = (ref) =>
        ref.startsWith('data:')
          ? parseDataUri(ref)
          : JSON.parse(readFileSync(path.resolve(path.dirname(file), decodeURIComponent(ref)), 'utf8'));
    } else if (/^https?:\/\//.test(key)) {
      const res = await fetch(key);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      js = await res.text();
      defaultRef = `${key}.map`;
      loadRef = async (ref) => {
        if (ref.startsWith('data:')) return parseDataUri(ref);
        const r = await fetch(new URL(ref, key));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
    } else {
      throw new Error(`unsupported url: ${key}`);
    }
    const refs = [...js.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
    const ref = refs.length ? refs[refs.length - 1][1] : defaultRef;
    sm = new SourceMap(await loadRef(ref));
  } catch {
    sm = null;
  }
  mapCache.set(key, sm);
  return sm;
}

// Normalize sourcemap source names like "turbopack://[project]/src/x.tsx",
// "webpack://_N_E/./src/x.tsx" or "file:///D:/proj/src/x.tsx" to a
// project-relative path.
function cleanOriginal(src) {
  if (!src) return null;
  let s = decodeURIComponent(String(src)).replace(/\\/g, '/');
  const proj = s.indexOf('[project]/');
  if (proj !== -1) return s.slice(proj + '[project]/'.length);
  s = s.replace(/^(webpack|turbopack):\/\/[^/]*\//, '').replace(/^file:\/\/\/?/, '').replace(/^\.\//, '');
  const m = s.match(/(?:^|\/)((?:src|app|pages|components|lib|features)\/.+)$/);
  return m ? m[1] : s;
}

// Best-effort human label for a target line — the nearest JSX/line comment
// above it (e.g. "{/* Badge */}" or "// Concentric Pulse Dot"), within a
// small window. Lets the consuming agent recognize the right block in a
// large file without reading much around jsxSource's line number.
function nearbyLabel(absPath, line) {
  try {
    const lines = readFileSync(absPath, 'utf8').split('\n');
    for (let i = line - 1; i >= 0 && i >= line - 20; i--) {
      const m = lines[i].match(/\{\s*\/\*\s*(.+?)\s*\*\/\s*\}/) || lines[i].match(/\/\/\s*(.+)/);
      if (m) return m[1].trim().slice(0, 80);
    }
  } catch {}
  return null;
}

export async function resolveFrame(frame) {
  if (!frame || !frame.url || !frame.line) return null;
  try {
    const sm = await sourceMapFor(frame.url);
    if (!sm) return null;
    let fileName = null;
    let lineNumber = null;
    if (typeof sm.findOrigin === 'function') {
      const o = sm.findOrigin(frame.line, frame.col || 1);
      if (o && o.fileName != null) {
        fileName = o.fileName;
        lineNumber = o.lineNumber;
      }
    }
    if (fileName == null) {
      const e = sm.findEntry(frame.line - 1, (frame.col || 1) - 1);
      if (e && e.originalSource != null) {
        fileName = e.originalSource;
        lineNumber = e.originalLine != null ? e.originalLine + 1 : null;
      }
    }
    const clean = cleanOriginal(fileName);
    if (!clean || /node_modules|(?:^|\/)\.next\//.test(clean)) return null;
    return lineNumber ? `${clean}:${lineNumber}` : clean;
  } catch {
    return null;
  }
}

// Mutates the payload: fills chain entry sources + jsxSource, builds a
// deduplicated per-annotation sources list, attaches a nearbyLabel hint when
// a projectRoot is known, and drops the raw frames.
export async function resolveAnnotations(data, projectRoot) {
  for (const a of data.annotations || []) {
    const sources = [];
    const push = (s) => {
      if (!s) return;
      const file = s.replace(/:\d+$/, '');
      if (!sources.some((x) => x.replace(/:\d+$/, '') === file)) sources.push(s);
    };
    if (!a.jsxSource) a.jsxSource = await resolveFrame(a.jsxFrame);
    if (projectRoot && a.jsxSource) {
      const m = a.jsxSource.match(/^(.*):(\d+)$/);
      if (m) {
        const label = nearbyLabel(path.join(projectRoot, m[1]), Number(m[2]));
        if (label) a.nearbyLabel = label;
      }
    }
    push(a.jsxSource);
    (a.sources || []).forEach(push);
    for (const c of a.componentChain || []) {
      if (!c.source && c.frame) c.source = await resolveFrame(c.frame);
      push(c.source);
      delete c.frame;
    }
    delete a.jsxFrame;
    a.sources = sources;
  }
  return data;
}
