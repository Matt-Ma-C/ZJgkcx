import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const payload = JSON.parse(
  await readFile(new URL("../public/data/jobs.json", import.meta.url), "utf8"),
);

const expectedCities = new Set([
  "省级机关",
  "杭州市",
  "宁波市",
  "温州市",
  "嘉兴市",
  "湖州市",
  "绍兴市",
  "金华市",
  "衢州市",
  "舟山市",
  "台州市",
  "丽水市",
]);
const expectedYears = new Set([2024, 2025, 2026]);

test("岗位数据覆盖2024—2026年浙江全省", () => {
  assert.ok(payload.jobs.length > 10_000);
  assert.equal(payload.meta.stats.jobCount, payload.jobs.length);
  assert.deepEqual(new Set(payload.jobs.map((job) => job.city)), expectedCities);
  assert.deepEqual(new Set(payload.jobs.map((job) => job.year)), expectedYears);
  assert.equal(new Set(payload.jobs.map((job) => job.id)).size, payload.jobs.length);
});

test("市—区县层级完整且岗位归属有效", () => {
  assert.deepEqual(new Set(payload.options.cities), expectedCities);
  assert.deepEqual(
    new Set(Object.keys(payload.options.districtsByCity)),
    expectedCities,
  );
  assert.ok(payload.options.districtsByCity["金华市"].includes("金东区"));
  assert.ok(
    payload.jobs.some(
      (job) => job.city === "金华市" && job.district === "金东区",
    ),
  );
  for (const job of payload.jobs) {
    assert.ok(
      payload.options.districtsByCity[job.city]?.includes(job.district),
      `${job.id} 的市—区县归属无效：${job.city}/${job.district}`,
    );
  }
});

test("缴费人数和报录比计算一致", () => {
  for (const job of payload.jobs) {
    if (job.paymentCount === null) {
      assert.equal(job.reportRatio, null);
      continue;
    }
    assert.ok(job.hires > 0, `${job.id} 招录人数应大于 0`);
    assert.equal(
      job.reportRatio,
      Math.round((job.paymentCount / job.hires) * 100) / 100,
      `${job.id} 报录比不一致`,
    );
  }
});

test("2025、2026年岗位和缴费数据覆盖正常", () => {
  for (const year of [2025, 2026]) {
    const jobs = payload.jobs.filter((job) => job.year === year);
    const paymentMatched = jobs.filter((job) => job.paymentCount !== null).length;
    assert.ok(jobs.length > 3_000, `${year} 年岗位数量异常`);
    assert.ok(
      paymentMatched / jobs.length > 0.98,
      `${year} 年缴费数据匹配率不足：${paymentMatched}/${jobs.length}`,
    );
  }
});

test("最低进面分数取岗位进面人员最低笔试成绩", () => {
  for (const job of payload.jobs) {
    const writtenScores = job.interviewees
      .map((person) => person.writtenScore)
      .filter((score) => score !== null);
    const expectedMinimum = writtenScores.length > 0 ? Math.min(...writtenScores) : null;
    assert.equal(
      job.minimumWrittenScore,
      expectedMinimum,
      `${job.id} 最低进面分数不一致`,
    );
  }
});

test("人员记录在同一岗位内没有重复准考证号", () => {
  for (const job of payload.jobs) {
    const interviewTickets = job.interviewees.map((person) => person.ticket);
    const admissionTickets = job.admitted.map((person) => person.ticket);
    assert.equal(
      new Set(interviewTickets).size,
      interviewTickets.length,
      `${job.id} 存在重复进面记录`,
    );
    assert.equal(
      new Set(admissionTickets).size,
      admissionTickets.length,
      `${job.id} 存在重复录用记录`,
    );
  }
});

test("筛选选项均由岗位数据生成", () => {
  assert.deepEqual(new Set(payload.options.years), expectedYears);
  for (const key of [
    "education",
    "identity",
    "political",
    "ethnicity",
    "age",
    "psychologicalTest",
    "physicalTest",
    "professionalTest",
  ]) {
    assert.ok(Array.isArray(payload.options[key]));
    assert.ok(payload.options[key].length > 0, `${key} 选项不能为空`);
  }
});
