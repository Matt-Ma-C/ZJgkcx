import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { analyzeSelection, buildJobMetrics, formatAnalyticsContext } from "../app/analytics.ts";
import { createEmptyFilters } from "../app/selection-workflow.ts";
import { emptyProfile } from "../app/qualification.ts";
import { readPublishedIndex } from "../scripts/public-data.mjs";

// Exercise the page's actual pure selectors without mounting React or making a request.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["toAnalyticsJob", "formatValue", "personNameNotice", "formatRatio", "formatScore", "percentile", "scoreDistribution", "escapeMarkdown", "summarizeFilters", "buildJobsMarkdown"]);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size);
const normalizeIdentity = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === "normalizeIdentity"));
let csvBody;
function findCsv(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "exportCsv") csvBody = node.initializer.body;
  ts.forEachChild(node, findCsv);
}
findCsv(source);
const csvSelectors = csvBody.statements.filter(node => ts.isForOfStatement(node) || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === "rows")));
assert.equal(csvSelectors.length, 2);
const moduleUrl = file => JSON.stringify(new URL(`../app/${file}.ts`, import.meta.url).href);
const compiled = ts.transpileModule([
  `import {buildCsv} from ${moduleUrl("selection-workflow")};`,
  `import {minimumAdmittedWrittenScore} from ${moduleUrl("admission-score")};`,
  `import {qualificationStatusLabel, matchQualification} from ${moduleUrl("qualification")};`,
  normalizeIdentity.getText(source),
  ...functions.map(node => node.getText(source)),
  `export {toAnalyticsJob, buildJobsMarkdown, personNameNotice};`,
  `export function pageCsv(availableJobs, applied, appliedMode, appliedProfile, data) {${csvSelectors.map(node => node.getText(source)).join("\n")} return buildCsv(rows);}`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { toAnalyticsJob, buildJobsMarkdown, pageCsv, personNameNotice } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);

test("仅来源已脱敏或含私用字形的姓名展示对应提示，普通姓名不加标签", () => {
  assert.equal(personNameNotice({ name: "张三", nameStatus: "public" }), "");
  assert.equal(personNameNotice({ name: "张\u00a0三", nameStatus: "public" }), "");
  assert.equal(personNameNotice({ name: "张**", nameStatus: "source-masked" }), "来源已脱敏");
  assert.equal(personNameNotice({ name: "张\ue863", nameStatus: "public" }), "来源含特殊字形，待核验");
  assert.match(page, /person\.name \|\| "来源未提供姓名"/);
});

test("显示来源姓名后，AI统计、Markdown和CSV导出仍不携带人员姓名与关联编号", async () => {
  const { index } = await readPublishedIndex(fileURLToPath(new URL("../public/", import.meta.url)));
  const ticket = "anon-1234567890abcdef1234";
  const job = {
    ...index.jobs[0],
    interviewees: [{ name: "面试姓名哨兵甲", nameStatus: "public", ticket, writtenScore: 132, interviewScore: 82 }],
    admitted: [{ name: "录用姓名哨兵乙", nameStatus: "public", ticket }],
    intervieweeCount: 1,
    admittedCount: 1,
  };
  const filters = createEmptyFilters();
  const analyticsJob = toAnalyticsJob(job, true);
  const metrics = buildJobMetrics([analyticsJob]);
  const analytics = analyzeSelection([analyticsJob], [analyticsJob], metrics);
  const outputs = [
    JSON.stringify(analyticsJob),
    formatAnalyticsContext(analytics, [analyticsJob], metrics),
    buildJobsMarkdown([job], filters, metrics),
    ...["requirements", "profile"].map(mode => pageCsv([job], filters, mode, emptyProfile(), { meta: { dataVersion: index.meta.dataVersion } })),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, /面试姓名哨兵甲|录用姓名哨兵乙|anon-1234567890abcdef1234/);
    assert.ok(output.includes(job.unit));
  }
  assert.equal(Object.hasOwn(analyticsJob, "interviewees"), false);
  assert.equal(Object.hasOwn(analyticsJob, "admitted"), false);
  assert.equal(job.interviewees[0].name, "面试姓名哨兵甲", "统计和导出不得修改详情姓名");
});
