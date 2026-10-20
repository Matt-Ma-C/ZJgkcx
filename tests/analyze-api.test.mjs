import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Compile in an isolated context so every external request is replaced by a mock.
const source = await readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport const __test = { isRateLimited, rateLimitBuckets };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function route(fetchMock, overrides = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, fetch: fetchMock, Request, Response, TextEncoder, TextDecoder, AbortController, DOMException, URL, crypto: webcrypto,
    setTimeout, clearTimeout, ...overrides,
  });
  return exports;
}

const snapshot = { filters: { city: ["杭州市", "宁波市"], physicalTest: "否", lockedConditions: ["city", "physicalTest"] }, jobIds: ["job-1"], dataVersion: "test-data-v1" };
const payload = (overrides = {}) => ({ apiKey: "sk-test-only-no-live-calls", jobCount: 1, jobMarkdown: "测试统计：成绩口径待确认。", considerPoliceJobs: false, snapshot, ...overrides });
const request = (body, options = {}) => new Request("http://127.0.0.1/api/analyze", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1", ...options.headers }, body: JSON.stringify(body), signal: options.signal,
});
const validResponse = () => Response.json({ choices: [{ message: { content: "无足够证据推荐" } }] });

test("仅接受本站来源的 JSON，不使用转发主机头授权", async () => {
  let calls = 0;
  const { POST } = route(async () => { calls += 1; return validResponse(); });
  for (const headers of [
    { Origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
    { Origin: "http://127.0.0.1.attacker.example" },
    { Origin: "null" },
    { Origin: "" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    assert.equal((await POST(request(payload(), { headers }))).status, 403);
  }
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    assert.equal((await POST(request(payload(), { headers: { "Content-Type": type } }))).status, 415);
  }
  assert.equal(calls, 0);
  assert.equal((await POST(request(payload(), { headers: { "Content-Type": "application/json; charset=utf-8" } }))).status, 200);
});

test("异常 JSON 结构和字段类型不会崩溃或触发外部请求", async () => {
  let calls = 0;
  const { POST } = route(async () => { calls += 1; return validResponse(); });
  const invalid = [null, [], "x", payload({ apiKey: {} }), payload({ jobMarkdown: [] }),
    payload({ jobCount: "1" }), payload({ jobCount: 1.5 }), payload({ considerPoliceJobs: "false" }),
    payload({ snapshot: null }), payload({ snapshot: { ...snapshot, jobIds: ["job-1", "job-1"] } }),
    payload({ snapshot: { ...snapshot, filters: { profile: { name: "不得发送原始档案" } } } })];
  for (let index = 0; index < invalid.length; index += 1) {
    const response = await POST(request(invalid[index]));
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, "invalid_request");
    assert.equal(result.retryable, false);
    assert.equal(result.snapshot, null);
  }
  assert.equal(calls, 0);
});

test("以 UTF-8 字节限制正文，并在 JSON 解析前限制整个请求体", async () => {
  let calls = 0;
  const { POST } = route(async () => { calls += 1; return validResponse(); });
  assert.equal((await POST(request(payload({ jobMarkdown: "中".repeat(250_001) })))).status, 413);
  assert.equal((await POST(request(payload({ extra: "x".repeat(3_000_000) })))).status, 413);
  assert.equal((await POST(request(payload(), { headers: { "content-length": "3000001" } }))).status, 413);
  assert.equal(calls, 0);
});

test("成功结果绑定发起快照，提示允许零推荐并保留锁定条件", async () => {
  let upstream;
  const { POST } = route(async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init.redirect, "error");
    upstream = JSON.parse(init.body);
    return validResponse();
  });
  const response = await POST(request(payload()));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.analysis, "无足够证据推荐");
  assert.match(upstream.messages[0].content, /0—6/);
  assert.match(upstream.messages[0].content, /口径不明.*不得用于成绩优势或综合推荐/);
  assert.match(upstream.messages[0].content, /锁定条件/);
  assert.match(upstream.messages[1].content, /test-data-v1/);
});

test("上游错误、非 JSON 和非字符串结果保持稳定失败结构", async () => {
  for (const [mock, expectedStatus, expectedCode] of [
    [async () => new Response("账户拒绝", { status: 402 }), 402, "upstream_error"],
    [async () => new Response("invalid json"), 502, "invalid_upstream_response"],
    [async () => Response.json({ choices: [{ message: { content: 123 } }] }), 502, "empty_analysis"],
    [async () => { throw new Error("private network detail"); }, 502, "network_error"],
  ]) {
    const response = await route(mock).POST(request(payload()));
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    assert.equal(result.code, expectedCode);
    assert.deepEqual(result.snapshot, snapshot);
    assert.doesNotMatch(result.error, /private network detail/);
  }
});

test("切换查询取消请求时向上游传递 abort，并返回取消反馈", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let upstreamSignal;
  const { POST } = route(async (_url, init) => {
    upstreamSignal = init.signal;
    started();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  const pending = POST(request(payload(), { signal: controller.signal }));
  await ready;
  controller.abort();
  const response = await pending;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(response.status, 499);
  assert.equal((await response.json()).code, "cancelled");
});

test("上游即使不响应 abort 也会超时，且正文和上游定时器均清理", async () => {
  const timers = new Map();
  const cleared = new Set();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { POST } = route(async () => {
    started();
    return new Promise(() => {});
  }, { setTimeout: (callback, delay) => { timers.set(delay, callback); return delay; }, clearTimeout: (id) => { cleared.add(id); } });
  const pending = POST(request(payload()));
  await ready;
  timers.get(120_000)();
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
  assert.deepEqual([...cleared].sort((a, b) => a - b), [15_000, 120_000]);
});

test("不完整正文到期和用户取消都会取消读取，不调用上游且归还并发位", async () => {
  let calls = 0;
  let bodyTimeout;
  let bodyCancelled = false;
  const { POST } = route(async () => { calls += 1; return validResponse(); }, {
    setTimeout: (callback, delay) => { if (delay === 15_000) bodyTimeout = callback; return delay; }, clearTimeout: () => {},
  });
  const streamRequest = (signal) => new Request("http://127.0.0.1/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"apiKey":')); }, cancel() { bodyCancelled = true; return new Promise(() => {}); } }),
    duplex: "half", signal,
  });
  const pending = POST(streamRequest());
  bodyTimeout();
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal((await response.json()).code, "request_timeout");
  assert.equal(bodyCancelled, true);
  const controller = new AbortController();
  bodyCancelled = false;
  const cancelled = POST(streamRequest(controller.signal));
  controller.abort();
  assert.equal((await cancelled).status, 499);
  assert.equal(bodyCancelled, true);
  assert.equal(calls, 0);
  assert.equal((await POST(request(payload()))).status, 200);
});

test("并发包括正文及上游，达到上限后拒绝并在完成后恢复", async () => {
  const waiting = [];
  let allStarted;
  const ready = new Promise((resolve) => { allStarted = resolve; });
  const { POST } = route(async () => new Promise((resolve) => {
    waiting.push(() => resolve(validResponse()));
    if (waiting.length === 4) allStarted();
  }));
  const pending = Array.from({ length: 4 }, (_, index) => POST(request(payload({ apiKey: `sk-test-concurrency-only-${index}` }))));
  await ready;
  const rejected = await POST(request(payload()));
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, "busy");
  waiting.forEach((finish) => finish());
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), [200, 200, 200, 200]);
  const recovered = POST(request(payload()));
  while (waiting.length < 5) await new Promise((resolve) => setImmediate(resolve));
  waiting[4]();
  assert.equal((await recovered).status, 200);
});

test("尚未读完正文的请求也占用并发位，取消后全部归还", async () => {
  let calls = 0;
  const { POST } = route(async () => { calls += 1; return validResponse(); });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller) => POST(new Request("http://127.0.0.1/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
    body: new ReadableStream(), duplex: "half", signal: controller.signal,
  })));
  assert.equal((await POST(request(payload()))).status, 429);
  controllers.forEach((controller) => controller.abort());
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), [499, 499, 499, 499]);
  assert.equal(calls, 0);
  assert.equal((await POST(request(payload()))).status, 200);
});

test("同一 Key 限流不被伪造转发 IP 绕过，桶仅保存摘要", async () => {
  let calls = 0;
  const { POST, __test } = route(async () => { calls += 1; return validResponse(); });
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await POST(request(payload(), { headers: { "x-forwarded-for": `192.0.2.${index}`, "x-real-ip": `198.51.100.${index}` } }))).status, 200);
  }
  assert.equal((await POST(request(payload(), { headers: { "x-forwarded-for": "203.0.113.99", "x-real-ip": "203.0.113.100" } }))).status, 429);
  assert.equal(calls, 8);
  assert.equal(__test.rateLimitBuckets.size, 1);
  assert.match([...__test.rateLimitBuckets.keys()][0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([...__test.rateLimitBuckets]), /sk-test/);
  assert.equal((await POST(request(payload({ apiKey: "sk-another-test-only-no-live-calls" })))).status, 200);
});

test("密钥摘要保护不可用时拒绝调用上游", async () => {
  let calls = 0;
  const { POST } = route(async () => { calls += 1; return validResponse(); }, {
    crypto: { subtle: { digest: async () => { throw new Error("private crypto detail"); } } },
  });
  const response = await POST(request(payload()));
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, "protection_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /private crypto detail/);
  assert.equal(calls, 0);
});

test("上游响应字节和声明长度均有界，慢响应流受整体期限约束", async () => {
  for (const mock of [
    async () => new Response("x".repeat(1_000_001)),
    async () => new Response("{}", { headers: { "Content-Length": "1000001" } }),
  ]) {
    const response = await route(mock).POST(request(payload()));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "invalid_upstream_response");
  }
  let timeout;
  let streamCancelled = false;
  let responseStarted;
  const ready = new Promise((resolve) => { responseStarted = resolve; });
  const { POST } = route(async () => {
    responseStarted();
    return new Response(new ReadableStream({ cancel() { streamCancelled = true; return new Promise(() => {}); } }));
  }, { setTimeout: (callback, delay) => { if (delay === 120_000) timeout = callback; return delay; }, clearTimeout: () => {} });
  const pending = POST(request(payload()));
  await ready;
  // Let the mocked fetch resolve so its response body is being read.
  await new Promise((resolve) => setImmediate(resolve));
  timeout();
  assert.equal((await pending).status, 504);
  assert.equal(streamCancelled, true);
});

test("限流桶即使全部未过期仍保持真实上限，到期后可回收", async () => {
  let now = 1;
  class Clock extends Date { static now() { return now; } }
  const { __test } = route(async () => { throw new Error("禁止真实调用"); }, { Date: Clock });
  for (let index = 0; index < 10_000; index += 1) assert.equal(await __test.isRateLimited(`test-key-${index}`), false);
  assert.equal(await __test.isRateLimited("overflow"), true);
  assert.equal(__test.rateLimitBuckets.size, 10_000);
  now = 60_002;
  assert.equal(await __test.isRateLimited("after-expiry"), false);
  assert.equal(__test.rateLimitBuckets.size, 1);
});
