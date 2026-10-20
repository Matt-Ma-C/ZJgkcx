import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisSession, snapshotKey } from "../app/analysis-session.ts";

const snapshot = (overrides = {}) => ({ filters: { city: ["杭州市"], physicalTest: "否", profileRevision: 1 }, jobIds: ["job-1"], dataVersion: "v1", ...overrides });

test("筛选、岗位或数据版本变化后旧分析无法作为当前结果", () => {
  const session = createAnalysisSession();
  const first = session.begin(snapshot());
  assert.equal(session.isCurrent(first.id, snapshot()), true);
  for (const changed of [snapshot({ filters: { city: ["宁波市"] } }), snapshot({ jobIds: ["job-2"] }), snapshot({ dataVersion: "v2" })]) {
    assert.equal(session.isCurrent(first.id, changed), false);
  }
  const second = session.begin(snapshot({ dataVersion: "v2" }));
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(session.isCurrent(first.id, snapshot()), false);
  assert.equal(session.isCurrent(second.id, second.snapshot), true);
  session.finish(first.id);
  assert.equal(session.isCurrent(second.id, second.snapshot), true);
});

test("取消和失败后的结束处理不会恢复旧结果，也不影响下一次分析", () => {
  const session = createAnalysisSession();
  const first = session.begin(snapshot());
  session.cancel();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(session.isCurrent(first.id, snapshot()), false);
  const next = session.begin(snapshot());
  session.finish(next.id);
  assert.equal(session.isCurrent(next.id, snapshot()), false);
  assert.equal(session.isCurrent(session.begin(snapshot()).id, snapshot()), true);
});

test("快照与原对象分离，集合顺序不造成假变化，档案版本变化能识别", () => {
  const query = snapshot({ filters: { city: ["杭州市", "宁波市"], profileRevision: 1 }, jobIds: ["job-1", "job-2"] });
  const session = createAnalysisSession();
  const current = session.begin(query);
  const reordered = snapshot({ filters: { profileRevision: 1, city: ["宁波市", "杭州市"] }, jobIds: ["job-2", "job-1"] });
  assert.equal(snapshotKey(query), snapshotKey(reordered));
  query.filters.city.push("温州市");
  query.jobIds.push("job-3");
  assert.equal(current.snapshot.jobIds.length, 2);
  assert.equal(current.snapshot.filters.city.length, 2);
  assert.equal(session.isCurrent(current.id, snapshot({ ...reordered, filters: { ...reordered.filters, profileRevision: 2 } })), false);
});
