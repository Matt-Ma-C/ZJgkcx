import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPublishedIndex, validatePublicData, validatePublishedPerson } from "../scripts/public-data.mjs";

const { index, manifest } = await readPublishedIndex(fileURLToPath(new URL("../public/", import.meta.url)));
const shards = await Promise.all([...new Set(index.jobs.map((job) => job.detailShard))].map(async (shard) =>
  JSON.parse(await readFile(new URL(`../public${shard}`, import.meta.url), "utf8"))));
const details = new Map(shards.flatMap((shard) => shard.jobs).map((job) => [job.id,job]));
const payload = {...index, jobs:index.jobs.map((job) => ({...job,...details.get(job.id)}))};

test("分片还原全部14200岗位及原顺序，版本、目录兼容与锁定哈希校验通过", async () => {
  const checked = await validatePublicData(fileURLToPath(new URL("../public/", import.meta.url)), fileURLToPath(new URL("../scripts/public-data-manifest.json", import.meta.url)));
  assert.equal(index.jobs.length,14200);
  assert.equal(manifest.shards.length,7);
  assert.equal(checked.reconstructedSha256,"ab1de67b06802db5b87a2d712f6e785c022b6ee1144da2971aad046a878480a0");
  assert.ok(checked.maximumAssetBytes <= 25 * 1024 * 1024);
});

test("发布人员校验允许来源姓名，区分来源脱敏和未提供姓名，拒绝额外身份字段", () => {
  const person = {name:"张三",nameStatus:"public",ticket:"anon-1234567890abcdef1234",writtenScore:100};
  validatePublishedPerson(person,"test");
  validatePublishedPerson({...person,name:"阿依古丽·买买提"},"test");
  validatePublishedPerson({...person,name:"张\u00a0三"},"test");
  validatePublishedPerson({...person,name:"张\ue863"},"test");
  validatePublishedPerson({...person,name:"张**",nameStatus:"source-masked"},"test");
  validatePublishedPerson({...person,name:"",nameStatus:"source-missing"},"test");
  for (const changed of [
    {name:"匿名001"},{name:""},{name:" 张三"},{name:"张\n三"},{name:"<img src=x>"},{name:"张**"},
    {name:"张三",nameStatus:"source-missing"},{nameStatus:"unverified"},{nameStatus:undefined},
    {ticket:"123456789123"},{schoolOrEmployer:"某大学"},{gender:"男"},{idCard:"123"},
    {realName:"张三"},{personalEmail:"user@example.com"},{interviewNote:"联系 user@example.com"},
    {interviewNote:"联系13812345678"},{interviewNote:"身份证 11010119900101001X"},
  ]) {
    assert.throws(() => validatePublishedPerson({...person,...changed},"test"));
  }
});

test("公开摘要与36分片版本一致，来源姓名与岗位内关联标识保留，其他身份字段未披露", () => {
  assert.equal(shards.length,36);
  assert.equal(index.meta.publicationSchema,"summary-v1");
  for (const shard of shards) assert.equal(shard.dataVersion,index.meta.dataVersion);
  assert.equal(details.size,index.jobs.length);
  for (const job of index.jobs) {
    assert.equal(job.interviewees.length,0);
    assert.equal(job.admitted.length,0);
    const detail = details.get(job.id);
    assert.ok(detail,job.id);
    assert.equal(job.intervieweeCount,detail.interviewees.length);
    assert.equal(job.admittedCount,detail.admitted.length);
    assert.equal(job.admissionSummary.listCompleteness,"unknown");
    assert.ok(["unknown","review"].includes(job.scoreProvenance.status));
    for (const person of [...detail.interviewees,...detail.admitted]) {
      validatePublishedPerson(person,job.id);
      assert.equal(person.nameStatus,"public");
      assert.ok(person.name.length > 0);
      assert.doesNotMatch(person.name,/^匿名/);
      assert.ok(person.ticket === "" || /^anon-[a-f0-9]{20}$/.test(person.ticket));
      assert.ok(!person.gender);
      assert.ok(!person.schoolOrEmployer);
    }
  }
});

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

test("人员记录在同一岗位内没有重复关联编号", () => {
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
