import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAnalysisGate, AI_LIMITS } from "../worker/ai-gate.ts";
import { checkPublicRequest, securePublicResponse } from "../worker/http-security.ts";

const origin = "https://gangcc.example";
const post = (path = "/api/analyze", headers = {}) => new Request(origin + path, {
  method: "POST", body: "{}", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
});
const migration = await readFile(new URL("../drizzle/0000_condemned_forge.sql", import.meta.url), "utf8");
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return { sqlite, prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return { bind(...params) { return {
      async first() { return stmt.get(...params) ?? null; },
      async run() { return stmt.run(...params); },
    }; } };
  } };
}

test("公开读取保持免登录，所有非分析写入口在框架解码前拒绝", () => {
  for (const method of ["GET", "HEAD"]) assert.equal(checkPublicRequest(new Request(origin, { method })), null);
  for (const path of ["/", "/unknown", "/api/analyze/", "/%61pi/analyze"]) assert.equal(checkPublicRequest(post(path)).status, 405);
  assert.equal(checkPublicRequest(new Request(origin, { method: "PUT" })).status, 405);
  assert.equal(checkPublicRequest(new Request(origin + "/_vinext/image?url=/favicon.svg")).status, 404);
  assert.equal(checkPublicRequest(new Request(origin + "/%5fvinext/image?url=/favicon.svg")).status, 404);
  assert.equal(checkPublicRequest(post()), null);
});

test("分析前置拒绝跨站、无Origin、非JSON、Action头和声明超大正文", () => {
  assert.equal(checkPublicRequest(post("/api/analyze", { Origin: "https://evil.example" })).status, 403);
  assert.equal(checkPublicRequest(post("/api/analyze", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const noOrigin = post(); noOrigin.headers.delete("origin");
  assert.equal(checkPublicRequest(noOrigin).status, 403);
  assert.equal(checkPublicRequest(post("/api/analyze", { "Content-Type": "text/plain" })).status, 415);
  for (const key of ["next-action", "rsc-action-id", "x-rsc-action"]) assert.equal(checkPublicRequest(post("/api/analyze", { [key]: "test" })).status, 400);
  assert.equal(checkPublicRequest(post("/api/analyze", { "Content-Length": "3000001" })).status, 413);
});

test("每次生成不可指定的CSP nonce并传入SSR，成功及错误返回安全头", async () => {
  let received;
  const render = (req) => { received = req; return Promise.resolve(new Response("html", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } })); };
  const first = await securePublicResponse(new Request(origin, { headers: { "Content-Security-Policy": "script-src 'nonce-attacker'", "x-forwarded-for": "fake", "x-real-ip": "fake" } }), render);
  const policy = first.headers.get("content-security-policy");
  assert.equal(received.headers.get("content-security-policy"), policy);
  assert.equal(received.headers.has("x-forwarded-for"), false);
  assert.equal(received.headers.has("x-real-ip"), false);
  assert.doesNotMatch(policy, /attacker|unsafe-eval/);
  assert.match(policy, /script-src 'self' 'nonce-[a-f0-9]{32}'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const second = await securePublicResponse(new Request(origin), render);
  assert.notEqual(second.headers.get("content-security-policy"), policy);
  const blocked = await securePublicResponse(post("/"), () => { throw Error("must not reach framework"); });
  assert.equal(blocked.status, 405);
  for (const response of [first, second, blocked]) {
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  }
});

test("D1不可用时仅AI关闭，不会以无限配额放行", async () => {
  assert.equal((await createAnalysisGate()(undefined)).status, 503);
  assert.equal((await createAnalysisGate()({ prepare() { throw Error("private database failure"); } })).status, 503);
});

test("拒绝请求会取消尚未读取的上传，且不等待恶意cancel", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const response = await securePublicResponse(new Request(origin, { method: "POST", body, duplex: "half" }), () => { throw Error("must not reach handler"); });
  assert.equal(response.status, 405);
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
});

test("多个独立gate共享SQLite原子并发租约，退出释放并能回收崩溃租约", async () => {
  const db = database(); const now = 1_800_000;
  const admissions = await Promise.all(Array.from({ length: 8 }, () => createAnalysisGate()(db, now)));
  const active = admissions.filter((x) => !(x instanceof Response));
  assert.equal(active.length, AI_LIMITS.concurrency);
  assert.equal(admissions.filter((x) => x instanceof Response && x.status === 429).length, 4);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM ai_leases").get().n, 4);
  await active[0].release(); await active[0].release();
  assert.equal((await createAnalysisGate()(db, now)) instanceof Response, false);
  const recovered = await createAnalysisGate()(db, now + AI_LIMITS.leaseMs + 1_000);
  assert.equal(recovered instanceof Response, false);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM ai_leases").get().n, 1);
  await recovered.release(); db.sqlite.close();
});

test("共享分钟配额不可通过创建新isolate绕过，跨分钟恢复但保留日计数", async () => {
  const db = database(); const now = 3_600_000;
  for (let i = 0; i < AI_LIMITS.perMinute; i++) {
    const admission = await createAnalysisGate()(db, now);
    assert.equal(admission instanceof Response, false); await admission.release();
  }
  assert.equal((await createAnalysisGate()(db, now)).status, 429);
  const next = await createAnalysisGate()(db, now + 60_000);
  assert.equal(next instanceof Response, false); await next.release();
  assert.equal(db.sqlite.prepare("SELECT day_count FROM ai_quota").get().day_count, 31);
  assert.equal((await createAnalysisGate()(db, now)).status, 429);
  assert.equal(db.sqlite.prepare("SELECT day_count FROM ai_quota").get().day_count, 31);
  db.sqlite.close();
});

test("数据库无响应时门禁独立超时并关闭AI", async () => {
  const pendingDb = { prepare() { return { bind() { return { first() { return new Promise(() => {}); } }; } }; } };
  const result = await createAnalysisGate(10)(pendingDb);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, "analysis_unavailable");
});

test("UTC日配额在多个isolate间生效，翌日恢复且数据库只含计数与随机租约", async () => {
  const db = database(); const now = 3_600_000;
  db.sqlite.prepare("INSERT INTO ai_quota VALUES ('global', 59, 0, 0, ?)").run(AI_LIMITS.perDay);
  assert.equal((await createAnalysisGate()(db, now)).status, 429);
  const nextDay = await createAnalysisGate()(db, 86_400_000);
  assert.equal(nextDay instanceof Response, false); await nextDay.release();
  assert.equal(db.sqlite.prepare("SELECT day_count FROM ai_quota").get().day_count, 1);
  const schema = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all().map((x) => x.sql).join(" ");
  assert.doesNotMatch(schema, /api_key|profile|filters|ip_address/i);
  db.sqlite.close();
});
