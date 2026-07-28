import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSelection,
  buildJobMetrics,
  formatAnalyticsContext,
} from "../app/analytics.ts";

function makeJob(index, overrides = {}) {
  const year = 2024 + (index % 3);
  return {
    id: `job-${index}`,
    year,
    city: index % 2 ? "杭州市" : "宁波市",
    district: index % 2 ? "西湖区" : "海曙区",
    unit: `单位${index}`,
    position: `职位${index}`,
    description: "综合管理",
    jobProperty: "综合类",
    bigCategory: "综合类",
    education: "本科及以上",
    degree: "学士及以上",
    identity: "不限",
    political: "不限",
    ethnicity: "不限",
    age: "18至35周岁",
    majors: "法学类",
    psychologicalTest: "否",
    physicalTest: "否",
    professionalTest: "否",
    notes: "",
    hires: 1,
    paymentCount: 40,
    reportRatio: 40,
    minimumWrittenScore: 132,
    intervieweeCount: 1,
    admittedCount: 1,
    writtenScoreSummary: "n=1；中位 132",
    interviewScoreSummary: "n=1；中位 82",
    warnings: [],
    ...overrides,
  };
}

test("历史难度在同年度同考试类别内标准化，低竞争岗位指数更低", () => {
  const jobs = Array.from({ length: 90 }, (_, index) =>
    makeJob(index, {
      reportRatio: index + 1,
      paymentCount: index + 1,
      minimumWrittenScore: 110 + index / 3,
      intervieweeCount: 1,
    }),
  );
  const metrics = buildJobMetrics(jobs);
  assert.ok(metrics.get("job-0").difficultyScore < metrics.get("job-89").difficultyScore);
  assert.match(metrics.get("job-0").difficultyBand, /难度低/);
  assert.equal(metrics.get("job-0").confidence, "高");
});

test("分析引擎计算条件影响、年度一致性和可应用的推荐组合", () => {
  const jobs = Array.from({ length: 180 }, (_, index) => {
    const favorable = index < 90;
    return makeJob(index, {
      city: favorable ? "杭州市" : "宁波市",
      district: favorable ? "临安区" : "鄞州区",
      professionalTest: favorable ? "是" : "否",
      reportRatio: favorable ? 10 + (index % 4) : 45 + (index % 7),
      paymentCount: favorable ? 10 + (index % 4) : 45 + (index % 7),
      minimumWrittenScore: favorable ? 118 + (index % 3) : 134 + (index % 3),
      intervieweeCount: 1,
    });
  });
  const metrics = buildJobMetrics(jobs);
  const analytics = analyzeSelection(jobs, jobs, metrics);
  const professionalImpact = analytics.factorImpacts.find(
    (impact) => impact.dimension === "专业加试" && impact.group === "是",
  );
  assert.ok(professionalImpact);
  assert.ok(professionalImpact.difficultyDelta < 0);
  assert.ok(professionalImpact.ratioDelta < 0);
  assert.equal(professionalImpact.stableYears, 3);
  assert.equal(professionalImpact.confidence, "高");
  assert.ok(
    analytics.recommendations.some((item) =>
      item.applyFilters.some(
        (filter) => filter.key === "professionalTest" && filter.value === "是",
      ),
    ),
  );
});

test("分析上下文使用程序统计并明确数据覆盖，不包含人员身份字段", () => {
  const jobs = Array.from({ length: 60 }, (_, index) =>
    makeJob(
      index,
      index % 3 === 0
        ? { minimumWrittenScore: null, intervieweeCount: 0 }
        : {},
    ),
  );
  const metrics = buildJobMetrics(jobs);
  const analytics = analyzeSelection(jobs, jobs, metrics);
  const context = formatAnalyticsContext(analytics, jobs, metrics);
  assert.match(context, /程序预计算的考情分析数据/);
  assert.match(context, /最低进面分覆盖/);
  assert.match(context, /历史难度指数/);
  assert.match(context, /低、中、高区间均衡抽样/);
  assert.match(context, /笔试成绩分布/);
  assert.doesNotMatch(context, /准考证号|某考生/);
});
