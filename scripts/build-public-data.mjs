import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Historical generator only. Stop before creating directories or reading any
// private input: this format would overwrite today's frozen named shards.
if (process.env.GANGCHACHA_ALLOW_LEGACY_ANONYMIZED !== "1") {
  console.error("已停止：这是旧匿名生成器，不用于当前实名冻结分片；正常构建用 npm run build / npm run data:validate。仅在隔离的历史维护副本中，经确认需要重建旧匿名版本时，才可显式设置 GANGCHACHA_ALLOW_LEGACY_ANONYMIZED=1。该旧流程会覆盖公开数据，不能用于当前发布版本。");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(root, "work", "data-private");
const publicDir = path.join(root, "public", "data");
const maintenanceDir = path.join(root, "data-maintenance");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (file) => access(file).then(() => true, () => false);
await mkdir(privateDir, { recursive: true });
await mkdir(maintenanceDir, { recursive: true });
await mkdir(path.join(publicDir, "jobs-details"), { recursive: true });

const inputArg = process.argv.indexOf("--input");
const backupPath = path.join(privateDir, "jobs.original.json");
const sourcePath = inputArg >= 0 ? path.resolve(process.argv[inputArg + 1])
  : await exists(backupPath) ? backupPath : path.join(publicDir, "jobs.json");
const raw = await readFile(sourcePath);
const payload = JSON.parse(raw.toString("utf8"));
if (payload.meta.publicationSchema) throw new Error("不能把公开摘要当作原始资料；请使用 --input 指向完整内部原始 JSON");
if (!Array.isArray(payload.jobs) || !payload.jobs.length) throw new Error("原始岗位数据格式错误");
if (sourcePath !== backupPath) {
  if (await exists(backupPath)) {
    if (sha256(await readFile(backupPath)) !== sha256(raw)) throw new Error("已有原始备份与输入不同；请先将新版本另存并人工记录修订，禁止覆盖旧备份");
  } else await copyFile(sourcePath, backupPath);
}
if (sha256(await readFile(backupPath)) !== sha256(raw)) throw new Error("原始备份校验失败");
const saltPath = path.join(privateDir, "anonymous-id.salt");
if (!(await exists(saltPath))) await writeFile(saltPath, randomBytes(32));
const salt = await readFile(saltPath);
const registryPath = path.join(maintenanceDir, "score-provenance.json");
if (!(await exists(registryPath))) await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, jobs: {}, note: "仅可根据已核验官方来源补充元数据；空登记表示尚未确认口径，不推定满分与折算规则。" }, null, 2) + "\n");
const registryBytes = await readFile(registryPath);
const registry = JSON.parse(registryBytes.toString("utf8"));
const dataVersion = `raw-${sha256(raw).slice(0, 12)}-rules-${sha256(registryBytes).slice(0, 12)}-build-${sha256(await readFile(fileURLToPath(import.meta.url))).slice(0, 10)}`;
const numberValues = (values) => values.filter((value) => typeof value === "number" && Number.isFinite(value));
const distribution = (values) => {
  const sorted = numberValues(values).sort((a, b) => a - b);
  if (!sorted.length) return "无已收录成绩";
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const quantile = fraction => { const position = (sorted.length - 1) * fraction; const low = Math.floor(position); return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low); };
  const show = value => Number(value.toFixed(2));
  return `n=${sorted.length}；最低${sorted[0]}；P25 ${show(quantile(.25))}；中位${show(median)}；均值${show(sorted.reduce((a,b) => a+b,0)/sorted.length)}；P75 ${show(quantile(.75))}；最高${sorted.at(-1)}（原始口径待核验）`;
};
const anon = (jobId, ticket) => ticket?.trim()
  ? `anon-${createHmac("sha256", salt).update(`${jobId}|${ticket}`).digest("hex").slice(0, 20)}` : "";
const audit = { dataVersion, sourceSha256: sha256(raw), sourceGeneratedAt: payload.meta.generatedAt,
  sameJobRangeSignals: [], sameJobAssociationConflicts: [], crossJobAssociationSignals: [], minimumScoreDisagreements: [], admissionCountSignals: [], existingWarningJobs: [], coverage: [], sourceTypes: {} };
const byTicket = new Map();
const cities = payload.options.cities;
const detailsByShard = new Map();
const jobs = [];
for (const job of payload.jobs) {
  const interviewees = job.interviewees ?? [];
  const admitted = job.admitted ?? [];
  const scores = numberValues(interviewees.map((person) => person.writtenScore));
  const reviewReasons = [];
  if (scores.some((score) => score < 90) && scores.some((score) => score > 110)) {
    audit.sameJobRangeSignals.push({ id: job.id, year: job.year, city: job.city, minimum: Math.min(...scores), maximum: Math.max(...scores), count: scores.length, sources: job.sources.entry.concat(job.sources.interview) });
    reviewReasons.push("同岗笔试原值跨越小于90与大于110的区间，原因待回查来源");
  }
  const byLocalTicket = new Map();
  for (const person of interviewees) {
    audit.sourceTypes[person.sourceType || "未注明"] = (audit.sourceTypes[person.sourceType || "未注明"] ?? 0) + 1;
    if (!person.ticket?.trim()) continue;
    const localValues = byLocalTicket.get(person.ticket) ?? [];
    localValues.push(person.writtenScore);
    byLocalTicket.set(person.ticket, localValues);
    const key = `${job.year}|${person.ticket}`;
    const rows = byTicket.get(key) ?? [];
    rows.push({ jobId: job.id, score: person.writtenScore, sourceType: person.sourceType });
    byTicket.set(key, rows);
  }
  for (const values of byLocalTicket.values()) {
    const distinct = [...new Set(numberValues(values))];
    if (distinct.length > 1) {
      audit.sameJobAssociationConflicts.push({ jobId: job.id, values: distinct });
      reviewReasons.push("同岗同关联标识出现不同笔试原值，待核验跨表记录");
    }
  }
  const expectedMinimum = scores.length ? Math.min(...scores) : null;
  if (job.minimumWrittenScore !== expectedMinimum) {
    audit.minimumScoreDisagreements.push({ id: job.id, stored: job.minimumWrittenScore, derivedFromRecordedPeople: expectedMinimum });
    reviewReasons.push("岗位摘要最低笔试原值与已收录人员最低值不同，保留原值待核验");
  }
  if (job.warnings?.length) audit.existingWarningJobs.push({ id: job.id, count: job.warnings.length });
  const override = registry.jobs?.[job.id] ?? {};
  const suppliedProvenance = override.scoreProvenance ?? {};
  const scoreProvenance = {
    status: reviewReasons.length && !override.reviewResolved ? "review" : "unknown",
    ...suppliedProvenance,
    ...(reviewReasons.length || suppliedProvenance.reviewReasons?.length ? { reviewReasons: [...reviewReasons, ...(suppliedProvenance.reviewReasons ?? [])] } : {}),
  };
  if (reviewReasons.length && !override.reviewResolved) scoreProvenance.status = "review";
  const matchedScores = [];
  let associationFailed = false;
  for (const person of admitted) {
    const matches = person.ticket?.trim() ? interviewees.filter((row) => row.ticket === person.ticket) : [];
    const values = [...new Set(numberValues(matches.map((row) => row.writtenScore)))];
    if (values.length !== 1) associationFailed = true;
    else matchedScores.push(values[0]);
  }
  const minAdmittedWrittenScore = admitted.length && !associationFailed ? Math.min(...matchedScores) : null;
  if (admitted.length && admitted.length !== job.hires) audit.admissionCountSignals.push({ id: job.id, plannedHires: job.hires, recordedAdmissions: admitted.length });
  const admissionSummary = {
    recordedCount: admitted.length, matchedWrittenCount: matchedScores.length,
    listCompleteness: "unknown",
    status: !admitted.length ? "uncollected" : associationFailed ? "association-failed" : "available",
    note: `名单完整状态未核实；收录${admitted.length}人，唯一关联笔试${matchedScores.length}人，计划${job.hires}人。仅为笔试原值，非最终录取线。`,
  };
  const scoreSummary = {
    written: distribution(interviewees.map((person) => person.writtenScore)),
    interview: distribution(interviewees.map((person) => person.interviewScore)),
    writtenCount: scores.length, interviewCount: numberValues(interviewees.map((person) => person.interviewScore)).length,
    rawMinimum: expectedMinimum, rawMaximum: scores.length ? Math.max(...scores) : null,
  };
  const detailShard = `/data/jobs-details/${job.year}-${String(cities.indexOf(job.city)).padStart(2, "0")}.json`;
  const sourceRecords = Object.entries(job.sources).flatMap(([stage, refs]) => (Array.isArray(refs) ? refs : refs ? [refs] : []).map((reference) => ({ stage, localReference: reference, officialUrl: null, publishedAt: null, collectedAt: null, originalRow: null, matchingBasis: "沿用历史汇总结果，原附件行号和关联过程待复核", status: "unverified" })));
  const dataStatus = {
    payment: job.paymentCount !== null ? "available" : job.sources.payment ? "association-failed" : "uncollected",
    written: scores.length ? "review" : interviewees.length || job.sources.entry.length || job.sources.interview.length ? "association-failed" : "uncollected",
    admission: admissionSummary.status,
    officialPublication: "unknown",
  };
  const safeWarnings = [ ...(job.warnings?.length ? [`历史汇总包含${job.warnings.length}条原始提示，需回查内部资料`] : []), ...reviewReasons ];
  const { sources: _sources, interviewees: _people, admitted: _admitted, ...fields } = job;
  void _sources; void _people; void _admitted;
  const summary = { ...fields, interviewees: [], admitted: [], intervieweeCount: interviewees.length, admittedCount: admitted.length,
    minAdmittedWrittenScore, admissionSummary, scoreSummary, scoreProvenance, dataStatus, detailShard,
    sources: { job: "", payment: "", entry: [], interview: [], admission: [] }, warnings: safeWarnings };
  jobs.push(summary);
  const detail = { id: job.id, dataVersion, sources: job.sources, sourceRecords,
    interviewees: interviewees.map((person, index) => ({ name: `匿名记录${index + 1}`, ticket: anon(job.id, person.ticket),
      writtenScore: person.writtenScore, writtenRank: person.writtenRank, interviewScore: person.interviewScore,
      professionalScore: person.professionalScore, totalScore: person.totalScore, rank: person.rank,
      interviewNote: person.interviewNote, sourceType: person.sourceType })),
    admitted: admitted.map((person, index) => ({ name: `匿名录用记录${index + 1}`, ticket: anon(job.id, person.ticket), gender: "", schoolOrEmployer: "" })),
  };
  const rows = detailsByShard.get(detailShard) ?? [];
  rows.push(detail);
  detailsByShard.set(detailShard, rows);
}
for (const rows of byTicket.values()) {
  if (new Set(rows.map((row) => row.jobId)).size > 1 && new Set(numberValues(rows.map((row) => row.score))).size > 1) {
    audit.crossJobAssociationSignals.push({ rows });
  }
}
for (const year of payload.options.years) for (const city of cities) {
  const rows = jobs.filter((job) => job.year === year && job.city === city);
  audit.coverage.push({ year, city, jobs: rows.length, payment: rows.filter((job) => job.paymentCount !== null).length,
    written: rows.filter((job) => job.minimumWrittenScore !== null).length, interview: rows.filter((job) => job.intervieweeCount).length,
    admission: rows.filter((job) => job.admittedCount).length, verifiedScoreBasis: rows.filter((job) => job.scoreProvenance.status === "verified").length });
}
const output = { ...payload, meta: { ...payload.meta, dataVersion, publicationSchema: "summary-v1", dataCutoff: null,
  maintenanceAsOf: "2026-10-19", scoreBasisNotice: "未回查原始官方计分说明，全部原值按未知或待复核口径展示；不做换算或成绩优势推荐。",
  publicationNotice: "首屏为岗位摘要；人员成绩按年度和城市分片按需加载，公开数据移除姓名、准考证号、性别与学校单位。完整原始资料保存在被忽略的内部 work/data-private。",
  scoreProvenanceDefaults: { status: "unknown", scoreType: null, maximum: null, subjects: [], conversionRule: null, comparisonKey: null, officialSourceUrl: null, sourceVersion: null },
  scoreSummaryNotice: "原始计分口径待核验，不比较分数优势。",
  missingDataNotice: "未收集不等于未公布；只有回查官方来源才能标记未公布。关联失败与待复核分别记录。",
  detailShardCount: detailsByShard.size }, jobs };
const bytes = JSON.stringify(output);
await writeFile(path.join(publicDir, "jobs-index.json"), bytes);
await writeFile(path.join(publicDir, "jobs.json"), bytes);
for (const [shard, rows] of detailsByShard) await writeFile(path.join(root, "public", shard.slice(1)), JSON.stringify({ dataVersion, jobs: rows }));
await writeFile(path.join(publicDir, "data-coverage.json"), JSON.stringify({ dataVersion, dataCutoff: null, generatedAt: payload.meta.generatedAt, stages: { available: "已收录", uncollected: "未收集", "association-failed": "关联失败", review: "待复核", unpublished: "官方确认未公布（当前未据此判定任何记录）" }, rows: audit.coverage }));
await writeFile(path.join(maintenanceDir, "data-audit.json"), JSON.stringify(audit, null, 2) + "\n");
await writeFile(path.join(privateDir, "manifest.json"), JSON.stringify({ sourcePath: path.relative(root, sourcePath), originalSha256: sha256(raw), bytes: raw.length, dataVersion, backup: "jobs.original.json", publicIndexBytes: Buffer.byteLength(bytes) }, null, 2) + "\n");
const lines = ["# 数据核验记录（2026-10-19）", "", `数据版本：${dataVersion}。原始汇总生成日期：${payload.meta.generatedAt}；实际数据截止时间未由官方来源确认，不能以生成日期代替。`, "", `原始 JSON SHA-256：\`${sha256(raw)}\`。字节一致备份位于被忽略的 work/data-private/jobs.original.json。`, "", "本次只核验现有汇总字段和关联线索，没有逐一取得原始官方附件，因此不能认定异常原因、满分或折算规则。全部原始数值保留，不乘除换算。现有计分口径登记为未知或待复核，不参与分差、综合指数与综合推荐。", "", `- 同岗同时存在小于90与大于110笔试原值：${audit.sameJobRangeSignals.length}岗，仅作为回查线索。`, `- 同岗同关联标识笔试值冲突：${audit.sameJobAssociationConflicts.length}项。`, `- 同年跨岗位关联标识出现不同笔试值：${audit.crossJobAssociationSignals.length}组，仅是跨表/关联线索，不能认定误匹配。`, `- 摘要最低值与已收录人员最低值不一致：${audit.minimumScoreDisagreements.length}岗，保留摘要原值。`, `- 已收录录用人数与计划人数不同：${audit.admissionCountSignals.length}岗；可能涉及计划调整等，不能直接认定漏录。`, `- 历史汇总有原始提示：${audit.existingWarningJobs.length}岗；完整提示保留内部资料。`, "", "## 同岗区间线索", "", "| 岗位 ID | 年度 | 地区 | 原值最小 | 原值最大 | 已收录值数量 |", "| --- | ---: | --- | ---: | ---: | ---: |", ...audit.sameJobRangeSignals.map((row) => `| ${row.id} | ${row.year} | ${row.city} | ${row.minimum} | ${row.maximum} | ${row.count} |`), "", "## 年度与地区收录覆盖", "", "数值描述本库覆盖，不能解释为当地真实分数水平或官方未公布比例。已核实口径数为0；人员总数和原始成绩仍保留。", "", "| 年度 | 地区 | 岗位 | 缴费 | 笔试原值 | 进面记录 | 录用记录 | 已核实计分口径 |", "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |", ...audit.coverage.map((row) => `| ${row.year} | ${row.city} | ${row.jobs} | ${row.payment} | ${row.written} | ${row.interview} | ${row.admission} | ${row.verifiedScoreBasis} |`), "", "## 仍需回查", "", "1. 各年度/类别/专业加试的笔试类型、满分、科目权重、折算方式及官方原文版本；不能根据分布猜测。", "2. 上述28个同岗区间线索、同关联标识跨表线索及原始解析提示。完整不含个人标识的岗位级列表见 data-audit.json。", "3. 官方来源 URL、发布日期、采集日期、原表行号和实际匹配依据；当前只能追溯历史相对附件路径，未知项明确为空。", "4. 录用名单完整状态、计划变化、名单修订及补录，不以收录人数等于计划人数作为完整证明。", "", "本次维护记录：将摘要/匿名详情分离；保留来源路径并增加空的可核验元数据；对未知与待复核口径暂停成绩比较；新增覆盖与复核记录。未修改成绩原值，未推送或部署。", ""];
await writeFile(path.join(maintenanceDir, "数据核验记录_2026-10-19.md"), lines.join("\n"));
console.log(JSON.stringify({ dataVersion, originalBytes: raw.length, indexBytes: Buffer.byteLength(bytes), shards: detailsByShard.size, jobs: jobs.length, rangeSignals: audit.sameJobRangeSignals.length, crossJobSignals: audit.crossJobAssociationSignals.length, originalBackupHashVerified: true }, null, 2));
