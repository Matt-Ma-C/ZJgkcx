import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const analyzeRoute = await readFile(
  new URL("../app/api/analyze/route.ts", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("行政区筛选为市单选、区县联动多选", () => {
  assert.match(page, /设区市（单选）/);
  assert.match(page, /districtsByCity\[draft\.city\]/);
  assert.match(page, /区县（多选）/);
  assert.match(page, /city: event\.target\.value,\s*district: \[\]/);
});

test("多选框点击外部后自动关闭", () => {
  assert.match(page, /document\.addEventListener\("pointerdown", closeOnOutsideClick\)/);
  assert.match(page, /details\.open = false/);
});

test("界面采用蓝白主题", () => {
  assert.match(styles, /--red:\s*#2563eb/);
  assert.match(styles, /--red-soft:\s*#eff6ff/);
});

test("Markdown 导出包含考情字段和成绩分布", () => {
  assert.match(page, /导出 Markdown/);
  assert.match(page, /参加面试人员的笔试和面试成绩分布/);
  assert.match(page, /P25/);
  assert.match(page, /中位/);
  assert.match(page, /P75/);
  assert.match(page, /buildJobsMarkdown\(availableJobs, applied\)/);
});

test("DeepSeek 分析在本地校验空岗位、Key 和岗位上限", () => {
  assert.match(page, /当前没有未隐藏的岗位，不会发起 API 调用/);
  assert.match(page, /请先输入 DeepSeek API Key/);
  assert.match(page, /ANALYSIS_JOB_LIMIT = 1000/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(analyzeRoute, /没有可供分析的岗位信息/);
  assert.match(analyzeRoute, /MAX_JOB_COUNT = 1000/);
});

test("DeepSeek 使用当前模型和考情分析系统提示词", () => {
  assert.match(analyzeRoute, /deepseek-v4-flash/);
  assert.match(analyzeRoute, /限男性\/适合男性/);
  assert.match(analyzeRoute, /少于 5 必须标“小样本，仅供观察”/);
  assert.match(analyzeRoute, /Authorization: `Bearer \$\{apiKey\}`/);
  assert.doesNotMatch(analyzeRoute, /sk-[A-Za-z0-9]{20,}/);
});

test("系统提示词逐项量化全部筛选条件并覆盖政治面貌", () => {
  for (const dimension of [
    "设区市、区县",
    "学历要求、学位要求",
    "现有身份要求",
    "政治面貌要求",
    "民族要求",
    "年龄要求",
    "专业要求或专业门类",
    "是否加试心理测评",
    "是否体能测试",
    "是否加试专业",
  ]) {
    assert.match(analyzeRoute, new RegExp(dimension));
  }
  assert.match(analyzeRoute, /政治面貌必须单独比较/);
  assert.match(analyzeRoute, /党员岗比不限岗位分数更高或更低/);
  assert.match(analyzeRoute, /# 筛选条件影响因子总览/);
  assert.match(analyzeRoute, /分数影响值/);
  assert.match(analyzeRoute, /原始相关，不能解释为独立影响/);
  assert.match(analyzeRoute, /max_tokens: 8192/);
});

test("单个岗位可隐藏、恢复且不参与导出和分析", () => {
  assert.match(page, /hiddenJobIds/);
  assert.match(page, /toggleHiddenJob\(job\.id\)/);
  assert.match(page, /取消隐藏/);
  assert.match(page, /className=\{hiddenJobIds\.has\(job\.id\) \? "is-hidden-job"/);
  assert.match(page, /filteredJobs\.filter\(\(job\) => !hiddenJobIds\.has\(job\.id\)\)/);
  assert.match(page, /buildJobsMarkdown\(analysisJobs, applied\)/);
  assert.match(styles, /\.job-table tbody tr\.is-hidden-job/);
});

test("公安岗位可选择纳入或排除分析", () => {
  assert.match(page, /是否考虑公安岗位/);
  assert.match(page, /availableJobs\.filter\(\(job\) => !isPoliceJob\(job\)\)/);
  assert.match(page, /considerPoliceJobs/);
  assert.match(analyzeRoute, /本次用户明确不考虑公安岗位/);
  assert.match(analyzeRoute, /不得引用、推荐或利用公安岗位的数据/);
  assert.match(analyzeRoute, /加试专业的岗位，可能形成竞争洼地/);
});

test("选岗分析结果使用 GFM Markdown 渲染器", () => {
  assert.match(page, /import ReactMarkdown from "react-markdown"/);
  assert.match(page, /import remarkGfm from "remark-gfm"/);
  assert.match(page, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>/);
  assert.ok(packageJson.dependencies["react-markdown"]);
  assert.ok(packageJson.dependencies["remark-gfm"]);
  assert.match(styles, /\.markdown-body table/);
  assert.match(styles, /\.markdown-body blockquote/);
});
