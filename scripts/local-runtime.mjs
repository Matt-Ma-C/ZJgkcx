import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Log, LogLevel, Miniflare, Response as WorkerResponse } from 'miniflare';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.html': 'text/html' };

export function releasePath(root, directory) {
  if (typeof directory !== 'string' || !/^release-[a-zA-Z0-9-]+$/.test(directory)) throw new Error('Invalid local release pointer.');
  return path.join(root, '.local-runtime', directory);
}

export async function readCurrentRelease(root) {
  const release = JSON.parse(await readFile(path.join(root, '.local-runtime/current.json'), 'utf8'));
  releasePath(root, release.directory);
  return release;
}

export async function serveLocalAsset(clientDirectory, request) {
  let name;
  try { name = decodeURIComponent(new URL(request.url).pathname); }
  catch { return new Response(null, { status: 400, headers: staticHeaders }); }
  const file = path.resolve(clientDirectory, '.' + name);
  const relative = path.relative(clientDirectory, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) return new Response(null, { status: 404, headers: staticHeaders });
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response(null, { status: 404, headers: staticHeaders });
    return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file)), { headers: {
      ...staticHeaders, 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': String(info.size), 'Cache-Control': 'no-cache',
    } });
  } catch { return new Response(null, { status: 404, headers: staticHeaders }); }
}

export async function applyLocalMigrations(db, migrationsDirectory) {
  await db.prepare('CREATE TABLE IF NOT EXISTS _gangchacha_local_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)').run();
  const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('Local D1 schema migrations are missing.');
  for (const name of files) {
    const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const applied = await db.prepare('SELECT sha256 FROM _gangchacha_local_migrations WHERE name = ?').bind(name).first();
    if (applied) {
      if (applied.sha256 !== digest) throw new Error(`Applied local D1 migration changed: ${name}`);
      continue;
    }
    const statements = sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
    // D1 batch executes all statements and its ledger insert in one transaction.
    await db.batch([
      ...statements.map((statement) => db.prepare(statement)),
      db.prepare('INSERT INTO _gangchacha_local_migrations (name, sha256, applied_at) VALUES (?, ?, ?)').bind(name, digest, Date.now()),
    ]);
  }
  await db.prepare('SELECT scope FROM ai_quota LIMIT 1').all();
  await db.prepare('SELECT token FROM ai_leases LIMIT 1').all();
}

export async function createLocalRuntime({ root = moduleRoot, releaseDirectory, stateDirectory, useDist = false } = {}) {
  const directory = useDist ? path.join(root, 'dist') : releasePath(root, releaseDirectory);
  const clientDirectory = path.join(directory, 'client');
  const serverDirectory = path.join(directory, 'server');
  const state = stateDirectory ? path.resolve(stateDirectory) : path.join(root, '.local-runtime/state');
  await mkdir(state, { recursive: true });
  process.env.MINIFLARE_REGISTRY_PATH = path.join(root, '.local-runtime/registry');
  const miniflare = new Miniflare({
    name: 'gangchacha-local', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    modules: true, modulesRoot: serverDirectory, scriptPath: path.join(serverDirectory, 'index.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true }],
    serviceBindings: { ASSETS: async (request) => {
      const response = await serveLocalAsset(clientDirectory, request);
      return new WorkerResponse(response.body, { status: response.status, headers: response.headers });
    } },
    d1Databases: { DB: 'gangchacha-local-analysis' }, d1Persist: path.join(state, 'd1'),
    cf: false, log: new Log(LogLevel.ERROR),
  });
  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database('DB');
    await applyLocalMigrations(db, useDist ? path.join(root, 'drizzle') : path.join(directory, 'migrations'));
    return { miniflare, db, clientDirectory };
  } catch (error) { await miniflare.dispose(); throw error; }
}

export async function switchCurrentRelease(root, directory) {
  releasePath(root, directory);
  const pointer = path.join(root, '.local-runtime/current.json');
  const temporary = path.join(root, `.local-runtime/current-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ directory }), { flag: 'wx' });
    // Same-volume rename preserves the previous pointer if preparation fails.
    await rename(temporary, pointer);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function prepareLocalRelease(root = moduleRoot) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const directory = `release-${stamp}-${process.pid}`;
  const target = releasePath(root, directory);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target, { recursive: false });
  await cp(path.join(root, 'dist/client'), path.join(target, 'client'), { recursive: true });
  await cp(path.join(root, 'dist/server'), path.join(target, 'server'), { recursive: true });
  await mkdir(path.join(target, 'migrations'));
  const migrations = (await readdir(path.join(root, 'drizzle'))).filter((name) => /^\d+_[\w-]+\.sql$/.test(name));
  for (const name of migrations) await copyFile(path.join(root, 'drizzle', name), path.join(target, 'migrations', name));
  const runtime = await createLocalRuntime({ root, releaseDirectory: directory });
  try {
    const response = await runtime.miniflare.dispatchFetch('http://127.0.0.1:43128/');
    if (response.status !== 200 || !response.headers.get('Content-Security-Policy')) throw new Error('Prepared local release failed its homepage/security smoke check.');
    await response.arrayBuffer();
  } finally { await runtime.miniflare.dispose(); }
  await switchCurrentRelease(root, directory);
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'prepare') throw new Error('Usage: node scripts/local-runtime.mjs prepare');
  console.log(`Local release ready: ${await prepareLocalRelease()}`);
}
