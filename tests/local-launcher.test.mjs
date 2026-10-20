import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalRuntime, prepareLocalRelease, readCurrentRelease, releasePath, serveLocalAsset } from '../scripts/local-runtime.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const fixtureSchema = 'CREATE TABLE ai_quota (scope TEXT PRIMARY KEY, minute_start INTEGER NOT NULL, minute_count INTEGER NOT NULL, day_start INTEGER NOT NULL, day_count INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE TABLE ai_leases (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);';

test('local D1 survives releases; invalid migration or interrupted preparation preserves the current pointer', { timeout: 60000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gangchacha-release-test-'));
  let active;
  try {
    await mkdir(path.join(fixture, 'dist/server'), { recursive: true });
    await mkdir(path.join(fixture, 'dist/client'), { recursive: true });
    await mkdir(path.join(fixture, 'drizzle'));
    await writeFile(path.join(fixture, 'dist/server/index.js'), 'export default { fetch() { return new Response("ready", {headers:{"Content-Security-Policy":"default-src \'self\'"}}); } };');
    await writeFile(path.join(fixture, 'drizzle/0000_test.sql'), fixtureSchema);
    const first = await prepareLocalRelease(fixture);
    active = await createLocalRuntime({ root: fixture, releaseDirectory: first });
    await active.db.prepare("INSERT INTO ai_quota VALUES ('global', 123, 7, 456, 19)").run();
    await active.miniflare.dispose(); active = undefined;
    const second = await prepareLocalRelease(fixture);
    assert.notEqual(second, first);
    active = await createLocalRuntime({ root: fixture, releaseDirectory: second });
    const quota = await active.db.prepare("SELECT minute_count, day_count FROM ai_quota WHERE scope = 'global'").first();
    assert.deepEqual(quota, { minute_count: 7, day_count: 19 });
    const migrations = await active.db.prepare('SELECT COUNT(*) AS count FROM _gangchacha_local_migrations').first();
    assert.equal(migrations.count, 1);
    await active.miniflare.dispose(); active = undefined;
    await writeFile(path.join(fixture, 'drizzle/0000_test.sql'), fixtureSchema + '\n-- changed after application');
    await assert.rejects(prepareLocalRelease(fixture), /Applied local D1 migration changed/);
    assert.equal((await readCurrentRelease(fixture)).directory, second);
    const incomplete = 'release-interrupted';
    await mkdir(releasePath(fixture, incomplete));
    await assert.rejects(createLocalRuntime({ root: fixture, releaseDirectory: incomplete }));
    assert.equal((await readCurrentRelease(fixture)).directory, second);
    assert.throws(() => releasePath(fixture, '../private'), /Invalid local release/);
  } finally {
    await active?.miniflare.dispose();
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('local static files keep security headers and reject private paths', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gangchacha-assets-test-'));
  try {
    await writeFile(path.join(fixture, 'safe.json'), '{"safe":true}');
    await writeFile(path.join(fixture, '.private'), 'hidden');
    const response = await serveLocalAsset(fixture, new Request('http://127.0.0.1/safe.json'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Permissions-Policy'), /camera=\(\)/);
    await response.arrayBuffer();
    for (const pathname of ['/.private', '/%2eprivate', '/..%5coutside', '/%zz']) {
      const rejected = await serveLocalAsset(fixture, new Request('http://127.0.0.1' + pathname));
      assert.ok([400, 404].includes(rejected.status), pathname);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

let prepared = false;
try {
  const current = JSON.parse(await readFile('.local-runtime/current.json', 'utf8'));
  prepared = existsSync(path.join('.local-runtime', current.directory, 'migrations'));
} catch { /* A clean clone can run npm start after npm run build without a prepared desktop release. */ }

test('prepared desktop and dist releases: cold starts, assets, D1-gated API and port conflict', { skip: !prepared, timeout: 60000 }, async () => {
  const url = 'http://127.0.0.1:43129';
  const state = await mkdtemp(path.join(os.tmpdir(), 'gangchacha-launch-test-'));
  try {
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      const child = spawn(process.execPath, ['scripts/local-server.mjs', ...(round === 2 ? ['--dist'] : [])], {
        env: { ...process.env, GANGCHACHA_PORT: '43129', GANGCHACHA_STATE_PATH: state }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      child.stderr.on('data', (chunk) => { output += chunk; });
      try {
        let health;
        while (performance.now() - started < 15000) {
          if (child.exitCode !== null) throw new Error(output);
          try { health = await fetch(url + '/__gangchacha_health', { signal: AbortSignal.timeout(300) }).then((response) => response.json()); }
          catch { /* Wait for schema initialization before the listener becomes available. */ }
          if (health?.app === 'gangchacha' && health.pid === child.pid) break;
          await delay(50);
        }
        assert.equal(health?.pid, child.pid, output);
        assert.equal(health.database, 'ready');
        assert.equal(health.runtime, 'workerd');
        if (round === 2) assert.equal(health.release, 'dist');
        console.log(`Cold start ${round + 1}: ${Math.round(performance.now() - started)}ms`);
        const page = await fetch(url);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
        const html = await page.text();
        assert.match(html, /<title>岗查查<\/title>/);
        const files = [...new Set(html.match(/\/assets\/[^"\s<>]+?\.(?:js|css)/g))];
        assert.ok(files.length > 0, 'HTML must reference browser bundles');
        for (const file of [...files, '/favicon.svg', '/data/cities.json', '/data/counties.json']) {
          const response = await fetch(url + file);
          assert.equal(response.status, 200, file);
          assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
          await response.arrayBuffer();
        }
        const manifest = await fetch(url + '/data/jobs-index.json').then((response) => response.json());
        assert.equal(manifest.schema, 'job-index-shards-v1');
        assert.equal(manifest.jobCount, 14200);
        if (round === 0) {
          const chunks = [];
          for (const shard of manifest.shards) {
            const raw = await fetch(url + shard.path).then((response) => response.text());
            assert.equal(Buffer.byteLength(raw), shard.bytes);
            assert.equal(digest(raw), shard.sha256);
            chunks.push(JSON.parse(raw).jobs);
          }
          const jobs = chunks.flat();
          assert.equal(jobs.length, 14200);
          assert.equal(digest(JSON.stringify({ meta: manifest.meta, options: manifest.options, jobs })), manifest.reconstructedSha256);
        }
        const api = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: '{}' });
        assert.equal(api.status, 400, 'D1 admission must reach ordinary validation without a paid upstream call');
        assert.match(api.headers.get('Content-Type'), /json/);
        await api.arrayBuffer();
        const foreign = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: '{}' });
        assert.equal(foreign.status, 403);
        await foreign.arrayBuffer();
        assert.equal((await fetch(url + '/.vite/manifest.json')).status, 404);
        if (round === 0) {
          const duplicate = spawn(process.execPath, ['scripts/local-server.mjs'], {
            env: { ...process.env, GANGCHACHA_PORT: '43129', GANGCHACHA_STATE_PATH: state + '-duplicate' }, windowsHide: true, stdio: 'ignore',
          });
          const [code] = await once(duplicate, 'exit');
          assert.equal(code, 1);
        }
      } finally {
        if (child.exitCode === null) { const ended = once(child, 'exit'); child.send('gangchacha-stop'); await ended; }
      }
    }
  } finally {
    await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(state + '-duplicate', { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
