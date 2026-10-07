// Minimal static server for local development.
//
//   npm run serve   ->  http://localhost:8080/docs/
//
// The page fetches ../games/index.json and imports ../sdk/js/*.js as modules, so
// it needs a real origin. Opening index.html from the filesystem will not work:
// browsers block module and fetch() on file://. GitHub Pages serves the repo
// root as an origin, so the deployed version has no such problem.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.s1b': 'application/octet-stream',
  '.s1d': 'application/x-ndjson',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/' || path === '/docs' || path === '/docs/') path = '/docs/index.html';
    // Contain everything under the repo root.
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!resolve(file).startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${path.replace(/\/$/, '')}/index.html` }).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${req.url}`);
  }
});

server.listen(port, () => {
  console.log(`system one showcase: http://localhost:${port}/docs/`);
  console.log(`serving ${root}`);
});