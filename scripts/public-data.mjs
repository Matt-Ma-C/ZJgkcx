import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (condition, message) => assert.ok(condition, message);

export async function listFiles(directory, prefix = "") {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    fail(!entry.isSymbolicLink(), `公开目录禁止符号链接：${relative}`);
    if (entry.isDirectory()) results.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) results.push(relative);
    else throw new Error(`公开目录存在非普通文件：${relative}`);
  }
  return results.sort();
}

export async function readPublishedIndex(publicDir) {
  const manifest = JSON.parse(await readFile(path.join(publicDir, "data/jobs-index.json"), "utf8"));
  fail(manifest.schema === "job-index-shards-v1", "公开岗位目录版本无效");
  fail(Array.isArray(manifest.shards) && manifest.shards.length > 0, "公开岗位分片目录缺失");
  const seen = new Set();
  const chunks = [];
  for (const shard of manifest.shards) {
    fail(/^\/data\/jobs-summary\/[\w-]+\.json$/.test(shard.path) && !seen.has(shard.path), "摘要分片路径无效或重复");
    seen.add(shard.path);
    const raw = await readFile(path.join(publicDir, shard.path.slice(1)));
    fail(raw.length === shard.bytes && digest(raw) === shard.sha256, `摘要分片完整性错误：${shard.path}`);
    const part = JSON.parse(raw);
    fail(part.dataVersion === manifest.meta?.dataVersion, `摘要分片版本错误：${shard.path}`);
    fail(Array.isArray(part.jobs) && part.jobs.length === shard.jobCount && part.jobs[0]?.id === shard.firstId && part.jobs.at(-1)?.id === shard.lastId,
      `摘要分片记录数或顺序错误：${shard.path}`);
    chunks.push(part.jobs);
  }
  const index = { meta: manifest.meta, options: manifest.options, jobs: chunks.flat() };
  fail(index.jobs.length === manifest.jobCount && index.meta.stats.jobCount === index.jobs.length, "岗位总数与摘要目录不一致");
  fail(digest(JSON.stringify(index)) === manifest.reconstructedSha256, "重建摘要与已核验版本不同");
  return { index, manifest };
}

const personKeys = new Set(["name", "nameStatus", "ticket", "gender", "schoolOrEmployer", "writtenScore", "writtenRank", "interviewScore", "professionalScore", "totalScore", "rank", "interviewNote", "sourceType"]);
export function validatePublishedPerson(person, where) {
  fail(person && typeof person === "object" && !Array.isArray(person), `人员记录格式无效：${where}`);
  fail(Object.keys(person).every((key) => personKeys.has(key)), `人员记录含未批准字段：${where}`);
  fail(["public", "source-masked", "source-missing"].includes(person.nameStatus), `人员姓名来源状态无效：${where}`);
  fail(typeof person.name === "string" && person.name === person.name.trim() && person.name.length <= 80 && !/[\p{Cc}\p{Cf}<>]/u.test(person.name), `人员姓名格式无效：${where}`);
  if (person.nameStatus === "source-missing") fail(person.name === "", `来源缺失姓名必须留空：${where}`);
  else {
    fail(person.name.length > 0 && !/^匿名(?:(?:录用)?记录)?\d+$/.test(person.name), `人员姓名必须保留来源原值：${where}`);
    // Preserve source spacing and legacy private-use glyphs; never guess a replacement character.
    if (person.nameStatus === "public") fail(/^[\p{L}\p{M}\p{Zs}\p{Co}·•・.'’‘\-]+$/u.test(person.name), `公开姓名含非姓名字符：${where}`);
    else fail(/^[\p{L}\p{M}\p{Zs}\p{Co}·•・.'’‘\-*＊×_—－○◯□？?]+$/u.test(person.name), `来源脱敏姓名格式无效：${where}`);
  }
  fail(person.ticket === "" || /^anon-[a-f0-9]{20}$/.test(person.ticket), `岗位内关联标识格式无效：${where}`);
  fail(!person.gender && !person.schoolOrEmployer, `人员身份字段未清空：${where}`);
  // Notes remain useful evidence, but cannot carry phone, mailbox, or government ID values.
  for (const value of Object.values(person)) {
    if (typeof value !== "string") continue;
    fail(!/(?:\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.test(value), `人员文本含身份或联系方式：${where}`);
  }
}

function scanForbiddenKeys(value, where) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    fail(!/^(?:realName|fullName|idCard(?:Number)?|identityNumber|examineeNumber|admissionTicketNumber|身份证(?:号)?|准考证号|真实姓名|姓名)$/i.test(key), `公开数据含身份字段：${where}.${key}`);
    if (typeof child === "string") fail(!/\bsk-[a-zA-Z0-9]{20,}\b/.test(child), `公开数据疑似含 API 凭证：${where}.${key}`);
    if (child && typeof child === "object") scanForbiddenKeys(child, `${where}.${key}`);
  }
}

/** Validate frozen public assets, allowing published names while excluding other personal identity fields. This module never reads original private data. */
export async function validatePublicData(publicDir, pinnedPath) {
  const pinned = JSON.parse(await readFile(pinnedPath, "utf8"));
  fail(pinned.schema === "gangchacha-public-data-lock-v1", "公开数据锁文件版本无效");
  const allPublicFiles = await listFiles(publicDir);
  for (const relative of allPublicFiles) {
    const size = (await lstat(path.join(publicDir, relative))).size;
    fail(size <= MAX_ASSET_BYTES, `静态资产超过 25 MiB：${relative} (${size})`);
    fail(!/(?:^|\/)(?:\.env[^/]*|work|data-private|\.local-runtime|\.git|\.wrangler|node_modules)(?:\/|$)|\.(?:pem|key|pfx|p12|log)$/i.test(relative), `公开目录含内部资料：${relative}`);
  }
  const dataFiles = allPublicFiles.filter((relative) => relative.startsWith("data/"));
  assert.deepEqual(dataFiles, Object.keys(pinned.assets).sort(), "公开数据文件集合与锁文件不同，禁止默默添加或删除");
  for (const relative of dataFiles) {
    const raw = await readFile(path.join(publicDir, relative));
    fail(raw.length === pinned.assets[relative].bytes && digest(raw) === pinned.assets[relative].sha256, `公开数据与锁定版本不同：${relative}`);
    scanForbiddenKeys(JSON.parse(raw), relative);
  }
  const { index, manifest } = await readPublishedIndex(publicDir);
  fail(index.meta.publicationSchema === "summary-v1" && index.meta.dataVersion === pinned.dataVersion, "公开数据版本错误");
  fail(index.jobs.length === pinned.jobCount && manifest.reconstructedSha256 === pinned.reconstructedSha256, "公开岗位集合与原核验摘要不同");
  const compatible = await readFile(path.join(publicDir, "data/jobs.json"));
  assert.equal(compatible.toString(), await readFile(path.join(publicDir, "data/jobs-index.json"), "utf8"), "兼容目录 jobs.json 必须与 jobs-index.json 一致");
  const ids = new Set(index.jobs.map((job) => job.id));
  fail(ids.size === index.jobs.length, "岗位摘要存在重复 ID");
  const details = new Map();
  const detailPaths = [...new Set(index.jobs.map((job) => job.detailShard))];
  fail(detailPaths.length === 36 && index.meta.detailShardCount === 36, "详情分片数量异常");
  for (const detailPath of detailPaths) {
    fail(/^\/data\/jobs-details\/[\w-]+\.json$/.test(detailPath), "详情分片路径错误");
    const part = JSON.parse(await readFile(path.join(publicDir, detailPath.slice(1)), "utf8"));
    fail(part.dataVersion === index.meta.dataVersion && Array.isArray(part.jobs), `详情分片版本或格式错误：${detailPath}`);
    for (const job of part.jobs) {
      fail(ids.has(job.id) && !details.has(job.id), `详情岗位 ID 未知或重复：${job.id}`);
      fail(Array.isArray(job.interviewees) && Array.isArray(job.admitted), `人员列表格式错误：${job.id}`);
      for (const person of [...job.interviewees, ...job.admitted]) validatePublishedPerson(person, job.id);
      details.set(job.id, { job, detailPath });
    }
  }
  fail(details.size === ids.size, "摘要与详情岗位集合不同");
  const nameMapping = [];
  const nameCounts = {
    interviewees: { public: 0, "source-masked": 0, "source-missing": 0 },
    admitted: { public: 0, "source-masked": 0, "source-missing": 0 },
  };
  for (const job of index.jobs) {
    const detail = details.get(job.id);
    fail(job.detailShard === detail.detailPath, `摘要详情引用错位：${job.id}`);
    fail(job.interviewees.length === 0 && job.admitted.length === 0, `摘要携带人员记录：${job.id}`);
    fail(job.intervieweeCount === detail.job.interviewees.length && job.admittedCount === detail.job.admitted.length, `摘要人员数量错误：${job.id}`);
    fail(["unknown", "review"].includes(job.scoreProvenance?.status) && job.admissionSummary?.listCompleteness === "unknown", `待核验事实状态被改写：${job.id}`);
    for (const stage of ["interviewees", "admitted"]) {
      for (const [position, person] of detail.job[stage].entries()) {
        nameMapping.push([job.id, stage, position, person.name, person.nameStatus]);
        nameCounts[stage][person.nameStatus]++;
      }
    }
  }
  fail(pinned.personNamePublication?.schema === "official-source-names-v1", "公开姓名来源记录缺失");
  fail(digest(JSON.stringify(nameMapping)) === pinned.personNamePublication.nameMappingSha256, "姓名与岗位、名单环节或行序的映射已改变");
  assert.deepEqual(nameCounts, pinned.personNamePublication.counts, "公开姓名来源状态数量与锁定记录不一致");
  const coverage = JSON.parse(await readFile(path.join(publicDir, "data/data-coverage.json"), "utf8"));
  fail(coverage.dataVersion === pinned.dataVersion, "覆盖记录版本错误");
  return { dataVersion: pinned.dataVersion, jobs: ids.size, summaryShards: manifest.shards.length, detailShards: detailPaths.length, assets: dataFiles.length, maximumAssetBytes: Math.max(...Object.values(pinned.assets).map((asset) => asset.bytes)), reconstructedSha256: manifest.reconstructedSha256, nameCounts };
}
