import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalRuntime, readCurrentRelease, serveLocalAsset } from './local-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).some((argument) => argument !== '--dist')) throw new Error('Unsupported local server argument.');
const useDist = process.argv.includes('--dist');
const release = useDist ? { directory: 'dist' } : await readCurrentRelease(root);
const port = Number(process.env.GANGCHACHA_PORT || process.env.PORT || 43128);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port.');
const runtime = await createLocalRuntime({
  root, useDist, releaseDirectory: useDist ? undefined : release.directory,
  stateDirectory: process.env.GANGCHACHA_STATE_PATH,
});
let stopping = false;
const server = createServer(async (req, res) => {
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  const onClose = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', onClose);
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
    const url = `http://127.0.0.1:${port}${req.url}`;
    let response;
    if (req.url === '/__gangchacha_health' && ['GET', 'HEAD'].includes(req.method || 'GET')) {
      response = Response.json({ app: 'gangchacha', version: 1, release: release.directory, pid: process.pid, runtime: 'workerd', database: 'ready' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } else {
      const method = req.method || 'GET';
      const init = { method, headers: req.headers, signal: disconnected.signal,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) };
      response = ['GET', 'HEAD'].includes(method)
        ? await serveLocalAsset(runtime.clientDirectory, new Request(url, init))
        : new Response(null, { status: 404 });
      if (response.status === 404) response = await runtime.miniflare.dispatchFetch(url, init);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); }
    else await pipeline(Readable.fromWeb(response.body), res);
  } catch {
    // Keep request bodies, personal fields and API credentials out of diagnostics.
    if (!res.headersSent) res.writeHead(503, { 'Cache-Control': 'no-store' });
    res.end('Local service temporarily unavailable.');
  } finally {
    req.off('aborted', abort);
    res.off('close', onClose);
  }
});
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await runtime.miniflare.dispose();
  process.exit(code);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
// A test/parent launcher can release workerd and its SQLite handles before exit.
// This is an inherited Node IPC channel, never an HTTP shutdown endpoint.
process.on('message', (message) => { if (message === 'gangchacha-stop') void stop(); });
server.on('error', () => { console.error('Local listener failed; the port may already be in use.'); void stop(1); });
server.listen(port, '127.0.0.1', () => console.log(`Gangchacha ready: http://127.0.0.1:${port} (${release.directory}; persistent local D1)`));
