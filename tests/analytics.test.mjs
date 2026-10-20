import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSelection,
  buildJobMetrics,
  formatAnalyticsContext,
  scoreComparisonKey,
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
    scoreProvenance: { status: "verified", scoreType: "测试笔试合成分", maximum: 200,
      subjects: ["测试行测", "测试申论"], conversionRule: "测试原值无折算", comparisonKey: "fixture-200",
      officialSourceUrl: "https://example.gov.cn/fixture", sourceVersion: "fixture-v1" },
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

test("已核实口径仍排除负分、非有限数和超过满分的原始记录，含摘要最高值越界", () => {
  const jobs = Array.from({length:90},(_,index) => makeJob(index));
  jobs[0].minimumWrittenScore = -1;
  jobs[1].minimumWrittenScore = 201;
  jobs[2].minimumWrittenScore = Number.NaN;
  jobs[3].scoreSummary = {rawMinimum:132,rawMaximum:220};
  const metrics = buildJobMetrics(jobs);
  for (let index=0;index<4;index++) {
    assert.equal(scoreComparisonKey(jobs[index]),null);
    assert.equal(metrics.get(`job-${index}`).scorePercentile,null);
    assert.equal(metrics.get(`job-${index}`).difficultyScore,null);
    assert.equal(metrics.get(`job-${index}`).scoreStatus,"review");
    assert.match(metrics.get(`job-${index}`).evidenceReasons.join("；"),/待复核/);
  }
  assert.ok(scoreComparisonKey(makeJob(500,{minimumWrittenScore:0})));
  assert.ok(scoreComparisonKey(makeJob(501,{minimumWrittenScore:200})));
  assert.equal(jobs[0].minimumWrittenScore,-1,"只拦截比较，不改写原值");
});

test("人工比较键相同也必须验证满分、科目及公式指纹", () => {
  const first = makeJob(500,{minimumWrittenScore:80});
  const otherMaximum = {...first,scoreProvenance:{...first.scoreProvenance,maximum:100}};
  const otherSubjects = {...first,scoreProvenance:{...first.scoreProvenance,subjects:["不同测试科目"]}};
  const otherFormula = {...first,scoreProvenance:{...first.scoreProvenance,conversionRule:"不同测试公式"}};
  assert.notEqual(scoreComparisonKey(first),scoreComparisonKey(otherMaximum));
  assert.notEqual(scoreComparisonKey(first),scoreComparisonKey(otherSubjects));
  assert.notEqual(scoreComparisonKey(first),scoreComparisonKey(otherFormula));
});

test("未知成绩口径保留报名竞争，但不输出分数优势、综合排名或推荐", () => {
  const jobs = Array.from({ length: 180 }, (_, index) => makeJob(index, {
    scoreProvenance: {status:"unknown"}, city: index < 90 ? "杭州市" : "宁波市",
    reportRatio: index < 90 ? 10 : 100, minimumWrittenScore: index < 90 ? 60 : 140,
  }));
  const metrics = buildJobMetrics(jobs);
  assert.notEqual(metrics.get("job-0").ratioPercentile, null);
  assert.equal(metrics.get("job-0").scorePercentile, null);
  assert.equal(metrics.get("job-0").difficultyScore, null);
  const analytics = analyzeSelection(jobs, jobs, metrics);
  assert.equal(analytics.current.medianScore, null);
  assert.equal(analytics.current.comparableScoreCoverage, 0);
  assert.equal(analytics.recommendations.length, 0);
  assert.ok(analytics.factorImpacts.every((impact) => impact.scoreDelta === null && impact.difficultyDelta === null));
});

test("不同已核实计分口径不能直接比较分差或生成跨口径综合推荐", () => {
  const jobs = Array.from({ length: 180 }, (_, index) => {
    const job = makeJob(index, { city:index < 90 ? "杭州市" : "宁波市", professionalTest:index < 90 ? "是" : "否", reportRatio:index < 90 ? 10 : 100 });
    job.scoreProvenance = {...job.scoreProvenance, comparisonKey:index < 90 ? "fixture-100" : "fixture-200", maximum:index < 90 ? 100 : 200};
    return job;
  });
  const metrics = buildJobMetrics(jobs);
  const analytics = analyzeSelection(jobs, jobs, metrics);
  const impact = analytics.factorImpacts.find((item) => item.dimension === "专业加试" && item.group === "是");
  assert.equal(impact.scoreDelta, null);
  assert.equal(impact.difficultyDelta, null);
  assert.equal(analytics.current.medianScore, null);
  assert.equal(analytics.recommendations.length, 0);
});

test("缺少成绩的岗位不把报录比指标冒充综合指数；小类别不回退全年", () => {
  const jobs = Array.from({ length:90 }, (_, index) => makeJob(index, {
    bigCategory:index < 9 ? "小样本类" : "综合类", minimumWrittenScore:index === 30 ? null : 130 + index / 10,
  }));
  const metrics = buildJobMetrics(jobs);
  assert.equal(metrics.get("job-0").scorePercentile, null);
  assert.equal(metrics.get("job-0").difficultyScore, null);
  assert.notEqual(metrics.get("job-30").ratioPercentile, null);
  assert.equal(metrics.get("job-30").difficultyScore, null);
});

test("对照组低覆盖不推荐；年度一致性对持续有利与持续不利对称", () => {
  const jobs = Array.from({length:180}, (_, index) => makeJob(index, {
    city:index < 90 ? "杭州市" : "宁波市", reportRatio:index < 90 ? 10 : 80, minimumWrittenScore:index < 90 ? 115 : 140,
  }));
  const analytics = analyzeSelection(jobs,jobs,buildJobMetrics(jobs));
  const cityImpacts = analytics.factorImpacts.filter((item) => item.dimension === "设区市");
  assert.equal(cityImpacts.length,2);
  assert.ok(cityImpacts.every((item) => item.stableYears === 3 && item.observedYears === 3 && item.confidence === "高"));
  const lowCoverage = jobs.map((job,index) => index >= 90 && index % 2 ? {...job,minimumWrittenScore:null} : job);
  const result = analyzeSelection(lowCoverage,lowCoverage,buildJobMetrics(lowCoverage));
  assert.equal(result.recommendations.length,0);
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
