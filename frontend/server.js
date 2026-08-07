/**
 * Development server for the PalRoute frontend — not part of the deployed
 * artefact. Dependency-free, since serving the files as-is is the whole job.
 * Port 6767; the backend API runs separately on 6969.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 6767);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_ORIGIN = process.env.PALROUTE_API ?? 'http://127.0.0.1:6969';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Strip query and hash, so `/?api=…` resolves to the index page. */
function pathOnly(url) {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const cut = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(0, cut);
}

/** Resolve a URL path inside ROOT. Null when it escapes, e.g. `/../../secrets`. */
function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

/** Identify an image from its magic bytes rather than trusting the extension. */
function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.slice(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  return null;
}

async function tryFile(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * The only public directories. safePath blocks traversal, but without this
 * allowlist every file in the project root would still be readable.
 */
const PUBLIC_DIRS = ['pages', 'css', 'scripts', 'assets', 'data'];

function isPublic(abs) {
  const rel = abs.slice(ROOT.length + 1).split(sep)[0];
  return PUBLIC_DIRS.includes(rel);
}

/** `/` and extensionless routes resolve to pages/<name>.html. */
async function resolveTarget(rawUrl) {
  const urlPath = pathOnly(rawUrl || '/');

  if (urlPath === '/' || urlPath === '') {
    return tryFile(join(ROOT, 'pages', 'index.html'));
  }
  const direct = safePath(urlPath);
  if (!direct || !isPublic(direct)) {
    // Falls through to the page lookup below.
    const asPage = await tryFile(join(ROOT, 'pages', `${urlPath.replace(/^\//, '')}.html`));
    return asPage;
  }

  const asFile = await tryFile(direct);
  if (asFile) return asFile;

  if (!extname(direct)) {
    const asPage = await tryFile(join(ROOT, 'pages', `${urlPath.replace(/^\//, '')}.html`));
    if (asPage) return asPage;
    const asIndex = await tryFile(join(direct, 'index.html'));
    if (asIndex) return asIndex;
  }
  return null;
}

/**
 * Proxy /api/* to the backend so local development is same-origin: no CORS to
 * configure, and this server sees a dead backend and can say so precisely.
 */
async function proxyApi(req, res, rawUrl) {
  const upstreamPath = rawUrl.slice('/api'.length) || '/';
  const url = API_ORIGIN + upstreamPath;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: req.headers['content-type']
        ? { 'content-type': req.headers['content-type'] }
        : undefined,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error:
          `The PalRoute backend is not answering at ${API_ORIGIN}.\n\n` +
          `Start it:\n  cd backend && npm run serve\n\n` +
          `If that exits immediately, the dataset is missing — build it first:\n` +
          `  npm run data:fetch\n  npm run data:build`,
        cause: err instanceof Error ? err.message : String(err),
        upstream: API_ORIGIN,
      }),
    );
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const headers = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  // Pass through the API's x-palroute-* diagnostic headers.
  for (const [k, v] of upstream.headers) {
    if (k.toLowerCase().startsWith('x-palroute-')) headers[k] = v;
  }
  res.writeHead(upstream.status, headers);
  res.end(buf);
}

const server = createServer(async (req, res) => {
  try {
    const rawUrl = req.url ?? '/';
    if (rawUrl === '/api' || rawUrl.startsWith('/api/') || rawUrl.startsWith('/api?')) {
      return await proxyApi(req, res, rawUrl);
    }

    const target = await resolveTarget(rawUrl);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>404</title>` +
          `<body style="font:16px/1.6 system-ui;background:#0f1116;color:#e6e8ee;padding:3rem">` +
          `<h1>404</h1><p>No such page: <code>${(req.url ?? '').replace(/[<>&]/g, '')}</code></p>` +
          `<p><a href="/" style="color:#7dd3fc">Back to the map</a></p>`,
      );
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      // Sniffed type takes precedence over the extension.
      'Content-Type': sniffType(body) ?? MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // No caching in development.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${PORT} is already in use — PalRoute's frontend is probably already running.\n` +
        `Open http://${HOST}:${PORT} , or stop the other process first.\n\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, async () => {
  process.stdout.write(
    `\n  PalRoute frontend  →  http://${HOST}:${PORT}\n` +
      `  API proxied  /api  →  ${API_ORIGIN}\n`,
  );
  // Reports backend availability at startup, retrying while it boots.
  const probe = async () => {
    for (let i = 0; i < 12; i++) {
      try {
        const r = await fetch(`${API_ORIGIN}/health`);
        return r.ok ? 'ok' : `HTTP ${r.status}`;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return 'down';
  };

  const status = await probe();
  if (status === 'ok') {
    process.stdout.write(`  backend            →  reachable\n\n`);
  } else if (status === 'down') {
    process.stdout.write(
      `  backend            →  NOT RUNNING (waited 12s)\n\n` +
        `  Start it in another terminal:\n` +
        `    cd ../backend && npm run serve\n` +
        `  If that exits immediately, build the dataset first:\n` +
        `    npm run data:fetch && npm run data:build\n\n`,
    );
  } else {
    process.stdout.write(`  backend            →  ${status}\n\n`);
  }
});
