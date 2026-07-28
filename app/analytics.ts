export type AnalyticsJob = {
  id: string;
  year: number;
  city: string;
  district: string;
  unit: string;
  position: string;
  description: string;
  jobProperty: string;
  bigCategory: string;
  education: string;
  degree: string;
  identity: string;
  political: string;
  ethnicity: string;
  age: string;
  majors: string;
  psychologicalTest: string;
  physicalTest: string;
  professionalTest: string;
  notes: string;
  hires: number;
  paymentCount: number | null;
  reportRatio: number | null;
  minimumWrittenScore: number | null;
  intervieweeCount: number;
  admittedCount: number;
  writtenScoreSummary?: string;
  interviewScoreSummary?: string;
  warnings: string[];
};

export type ConfidenceLevel = "高" | "中" | "较低" | "数据不足";

export type JobMetric = {
  difficultyScore: number | null;
  difficultyBand: string;
  confidence: ConfidenceLevel;
  ratioPercentile: number | null;
  scorePercentile: number | null;
  cohortSize: number;
  completeness: number;
};

export type AnalyticsSummary = {
  jobCount: number;
  hires: number;
  paymentCoverage: number;
  scoreCoverage: number;
  interviewCoverage: number;
  admissionCoverage: number;
  medianRatio: number | null;
  medianScore: number | null;
  medianDifficulty: number | null;
  highConfidenceJobs: number;
};

export type RecommendationFilter = {
  key:
    | "city"
    | "bigCategory"
    | "psychologicalTest"
    | "physicalTest"
    | "professionalTest"
    | "policeScope";
  value: string;
};

export type FactorImpact = {
  id: string;
  dimension: string;
  group: string;
  groupCount: number;
  comparisonCount: number;
  scoreCount: number;
  scoreCoverage: number;
  medianScore: number | null;
  scoreDelta: number | null;
  ratioCount: number;
  medianRatio: number | null;
  ratioDelta: number | null;
  medianDifficulty: number | null;
  difficultyDelta: number | null;
  direction: string;
  confidence: ConfidenceLevel;
  stableYears: number;
  observedYears: number;
  explanation: string;
  applyFilter?: RecommendationFilter;
};

export type CombinationRecommendation = {
  id: string;
  label: string;
  factors: FactorImpact[];
  jobCount: number;
  scoreCoverage: number;
  medianRatio: number | null;
  medianScore: number | null;
  medianDifficulty: number | null;
  difficultyDelta: number | null;
  ratioDelta: number | null;
  confidence: ConfidenceLevel;
  stableYears: number;
  observedYears: number;
  representativeJobIds: string[];
  applyFilters: RecommendationFilter[];
};

export type SelectionAnalytics = {
  eligible: AnalyticsSummary;
  current: AnalyticsSummary;
  factorImpacts: FactorImpact[];
  recommendations: CombinationRecommendation[];
};

type FactorDefinition = {
  id: string;
  dimension: string;
  group: string;
  recommendationEligible: boolean;
  matches: (job: AnalyticsJob) => boolean;
  applyFilter?: RecommendationFilter;
};

function finiteValues(values: Array<number | null | undefined>) {
  return values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value),
  );
}

function median(values: Array<number | null | undefined>) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number | null, digits = 2) {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(count: number, total: number) {
  return total ? count / total : 0;
}

function lowerBound(sorted: number[], target: number) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function percentileRank(sorted: number[], value: number) {
  if (sorted.length <= 1) return 50;
  const below = lowerBound(sorted, value);
  let upper = below;
  while (upper < sorted.length && sorted[upper] === value) upper += 1;
  return ((below + upper - 1) / 2 / (sorted.length - 1)) * 100;
}

function difficultyBand(value: number | null) {
  if (value === null) return "暂无判断";
  if (value < 20) return "历史难度低";
  if (value < 40) return "历史难度较低";
  if (value < 60) return "历史难度中等";
  if (value < 80) return "历史难度较高";
  return "历史难度高";
}

function completeness(job: AnalyticsJob) {
  const available = [
    job.paymentCount !== null,
    job.minimumWrittenScore !== null,
    job.intervieweeCount > 0,
    job.admittedCount > 0,
  ].filter(Boolean).length;
  return available / 4;
}

function jobConfidence(job: AnalyticsJob): ConfidenceLevel {
  const complete = completeness(job);
  if (
    complete === 1 &&
    job.minimumWrittenScore !== null &&
    job.intervieweeCount > 0 &&
    job.warnings.length === 0
  ) {
    return "高";
  }
  if (complete >= 0.75 && job.minimumWrittenScore !== null) return "中";
  if (complete >= 0.5) return "较低";
  return "数据不足";
}

function cohortKey(job: AnalyticsJob) {
  return `${job.year}|${job.bigCategory || job.jobProperty || "未分类"}`;
}

export function buildJobMetrics(jobs: AnalyticsJob[]) {
  const ratioByCohort = new Map<string, number[]>();
  const scoreByCohort = new Map<string, number[]>();
  const ratioByYear = new Map<number, number[]>();
  const scoreByYear = new Map<number, number[]>();

  for (const job of jobs) {
    const key = cohortKey(job);
    if (job.reportRatio !== null) {
      const cohortValues = ratioByCohort.get(key) ?? [];
      cohortValues.push(job.reportRatio);
      ratioByCohort.set(key, cohortValues);
      const yearValues = ratioByYear.get(job.year) ?? [];
      yearValues.push(job.reportRatio);
      ratioByYear.set(job.year, yearValues);
    }
    if (job.minimumWrittenScore !== null) {
      const cohortValues = scoreByCohort.get(key) ?? [];
      cohortValues.push(job.minimumWrittenScore);
      scoreByCohort.set(key, cohortValues);
      const yearValues = scoreByYear.get(job.year) ?? [];
      yearValues.push(job.minimumWrittenScore);
      scoreByYear.set(job.year, yearValues);
    }
  }

  for (const values of [
    ...ratioByCohort.values(),
    ...scoreByCohort.values(),
    ...ratioByYear.values(),
    ...scoreByYear.values(),
  ]) {
    values.sort((a, b) => a - b);
  }

  const metrics = new Map<string, JobMetric>();
  for (const job of jobs) {
    const key = cohortKey(job);
    const cohortRatios = ratioByCohort.get(key) ?? [];
    const cohortScores = scoreByCohort.get(key) ?? [];
    const ratioReference =
      cohortRatios.length >= 20 ? cohortRatios : ratioByYear.get(job.year) ?? [];
    const scoreReference =
      cohortScores.length >= 20 ? cohortScores : scoreByYear.get(job.year) ?? [];
    const ratioPercentile =
      job.reportRatio === null || !ratioReference.length
        ? null
        : percentileRank(ratioReference, job.reportRatio);
    const scorePercentile =
      job.minimumWrittenScore === null || !scoreReference.length
        ? null
        : percentileRank(scoreReference, job.minimumWrittenScore);
    const availablePercentiles = finiteValues([ratioPercentile, scorePercentile]);
    const difficultyScore =
      ratioPercentile !== null && scorePercentile !== null
        ? ratioPercentile * 0.55 + scorePercentile * 0.45
        : availablePercentiles.length
          ? availablePercentiles[0]
          : null;
    metrics.set(job.id, {
      difficultyScore: round(difficultyScore, 1),
      difficultyBand: difficultyBand(difficultyScore),
      confidence: jobConfidence(job),
      ratioPercentile: round(ratioPercentile, 1),
      scorePercentile: round(scorePercentile, 1),
      cohortSize: Math.max(ratioReference.length, scoreReference.length),
      completeness: completeness(job),
    });
  }
  return metrics;
}

function summarize(jobs: AnalyticsJob[], metrics: Map<string, JobMetric>): AnalyticsSummary {
  const jobMetrics = jobs
    .map((job) => metrics.get(job.id))
    .filter((metric): metric is JobMetric => Boolean(metric));
  return {
    jobCount: jobs.length,
    hires: jobs.reduce((total, job) => total + job.hires, 0),
    paymentCoverage: ratio(
      jobs.filter((job) => job.paymentCount !== null).length,
      jobs.length,
    ),
    scoreCoverage: ratio(
      jobs.filter((job) => job.minimumWrittenScore !== null).length,
      jobs.length,
    ),
    interviewCoverage: ratio(
      jobs.filter((job) => job.intervieweeCount > 0).length,
      jobs.length,
    ),
    admissionCoverage: ratio(
      jobs.filter((job) => job.admittedCount > 0).length,
      jobs.length,
    ),
    medianRatio: round(median(jobs.map((job) => job.reportRatio))),
    medianScore: round(median(jobs.map((job) => job.minimumWrittenScore))),
    medianDifficulty: round(
      median(jobMetrics.map((metric) => metric.difficultyScore)),
      1,
    ),
    highConfidenceJobs: jobMetrics.filter((metric) => metric.confidence === "高").length,
  };
}

function isPoliceJob(job: AnalyticsJob) {
  return /公安|人民警察|司法警察|特警/.test(
    [
      job.unit,
      job.position,
      job.description,
      job.jobProperty,
      job.bigCategory,
    ].join(" "),
  );
}

function topValues(
  jobs: AnalyticsJob[],
  getter: (job: AnalyticsJob) => string,
  maximum = 12,
) {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const value = getter(job).trim() || "未注明";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maximum)
    .map(([value]) => value);
}

function categoricalFactors(
  jobs: AnalyticsJob[],
  dimension: string,
  key: RecommendationFilter["key"] | null,
  getter: (job: AnalyticsJob) => string,
  recommendationEligible: boolean,
  maximum = 12,
): FactorDefinition[] {
  return topValues(jobs, getter, maximum).map((value) => ({
    id: `${dimension}:${value}`,
    dimension,
    group: value,
    recommendationEligible,
    matches: (job) => (getter(job).trim() || "未注明") === value,
    applyFilter:
      key === null
        ? undefined
        : {
            key,
            value,
          },
  }));
}

function factorDefinitions(jobs: AnalyticsJob[]) {
  const definitions: FactorDefinition[] = [
    ...categoricalFactors(jobs, "年度", null, (job) => String(job.year), false, 4),
    ...categoricalFactors(jobs, "设区市", "city", (job) => job.city, true),
    ...categoricalFactors(jobs, "区县", null, (job) => job.district, false, 15),
    ...categoricalFactors(
      jobs,
      "考试类别",
      "bigCategory",
      (job) => job.bigCategory || job.jobProperty,
      true,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "学历要求",
      null,
      (job) => job.education,
      false,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "学位要求",
      null,
      (job) => job.degree,
      false,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "现有身份",
      null,
      (job) => job.identity,
      false,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "民族要求",
      null,
      (job) => job.ethnicity,
      false,
      6,
    ),
    ...categoricalFactors(
      jobs,
      "年龄要求",
      null,
      (job) => job.age,
      false,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "政治面貌",
      null,
      (job) => job.political,
      false,
      8,
    ),
    ...categoricalFactors(
      jobs,
      "心理测评",
      "psychologicalTest",
      (job) => job.psychologicalTest,
      true,
      4,
    ),
    ...categoricalFactors(
      jobs,
      "体能测试",
      "physicalTest",
      (job) => job.physicalTest,
      true,
      4,
    ),
    ...categoricalFactors(
      jobs,
      "专业加试",
      "professionalTest",
      (job) => job.professionalTest,
      true,
      4,
    ),
    {
      id: "police:yes",
      dimension: "岗位类型",
      group: "公安及警察岗位",
      recommendationEligible: true,
      matches: isPoliceJob,
      applyFilter: { key: "policeScope", value: "only" },
    },
    {
      id: "hires:multiple",
      dimension: "招录人数",
      group: "招录2人及以上",
      recommendationEligible: true,
      matches: (job) => job.hires >= 2,
    },
  ];

  const noteTags: Array<[string, RegExp]> = [
    ["限男性或适合男性", /限男性|男性报考|适合男性/],
    ["户籍或生源限制", /户籍|生源地|生源/],
    ["应届毕业生", /应届毕业生|限应届|202[456]年毕业/],
    ["基层经历要求", /基层工作经历|基层经历/],
    ["资格证书要求", /资格证|职业资格|法律职业资格|会计师|审计师|建造师/],
    ["最低服务年限", /最低服务年限|服务期|服务年限/],
    ["野外夜间或艰苦环境", /野外|夜间|登高|艰苦|偏远|值班|加班/],
  ];
  for (const [group, pattern] of noteTags) {
    definitions.push({
      id: `notes:${group}`,
      dimension: "备注限制",
      group,
      recommendationEligible: true,
      matches: (job) => pattern.test(job.notes),
    });
  }

  const majorTags: Array<[string, RegExp]> = [
    ["专业不限或范围很宽", /不限|专业要求为：?无/],
    ["法学类", /法学|法律|诉讼法|宪法|行政法/],
    ["计算机与信息技术类", /计算机|软件工程|信息安全|网络工程|数据科学|人工智能/],
    ["经济金融类", /经济学|金融学|财政学|税收学|国际经济/],
    ["财会审计类", /会计|财务管理|审计|资产评估/],
    ["中文新闻类", /汉语言|中文|新闻|传播学|秘书学/],
    ["土木建筑与工程类", /土木|建筑|城乡规划|工程管理|测绘/],
    ["公共管理类", /公共管理|行政管理|社会保障|土地资源管理/],
  ];
  for (const [group, pattern] of majorTags) {
    definitions.push({
      id: `majors:${group}`,
      dimension: "专业门类",
      group,
      recommendationEligible: false,
      matches: (job) => pattern.test(job.majors),
    });
  }
  return definitions;
}

function comparisonConfidence(
  groupCount: number,
  comparisonCount: number,
  scoreCoverage: number,
  stableYears: number,
): ConfidenceLevel {
  if (
    groupCount >= 50 &&
    comparisonCount >= 50 &&
    scoreCoverage >= 0.65 &&
    stableYears >= 2
  ) {
    return "高";
  }
  if (groupCount >= 20 && comparisonCount >= 20 && scoreCoverage >= 0.45) {
    return "中";
  }
  if (groupCount >= 10 && comparisonCount >= 10) return "较低";
  return "数据不足";
}

function directionFor(
  difficultyDelta: number | null,
  ratioDelta: number | null,
) {
  if (difficultyDelta === null && ratioDelta === null) return "无法比较";
  const easierDifficulty = difficultyDelta !== null && difficultyDelta <= -5;
  const easierRatio = ratioDelta !== null && ratioDelta < 0;
  const harderDifficulty = difficultyDelta !== null && difficultyDelta >= 5;
  const harderRatio = ratioDelta !== null && ratioDelta > 0;
  if (easierDifficulty && easierRatio) return "可能降低历史门槛";
  if (harderDifficulty && harderRatio) return "可能提高历史门槛";
  if (easierDifficulty || easierRatio) return "部分指标较有利";
  if (harderDifficulty || harderRatio) return "部分指标较不利";
  return "影响不明显";
}

function yearlyStability(
  group: AnalyticsJob[],
  comparison: AnalyticsJob[],
  metrics: Map<string, JobMetric>,
) {
  const groupByYear = new Map<number, Array<number | null>>();
  const comparisonByYear = new Map<number, Array<number | null>>();
  for (const job of group) {
    const values = groupByYear.get(job.year) ?? [];
    values.push(metrics.get(job.id)?.difficultyScore ?? null);
    groupByYear.set(job.year, values);
  }
  for (const job of comparison) {
    const values = comparisonByYear.get(job.year) ?? [];
    values.push(metrics.get(job.id)?.difficultyScore ?? null);
    comparisonByYear.set(job.year, values);
  }
  const years = [...new Set([...groupByYear.keys(), ...comparisonByYear.keys()])];
  let observedYears = 0;
  let stableYears = 0;
  for (const year of years) {
    const groupValues = groupByYear.get(year) ?? [];
    const comparisonValues = comparisonByYear.get(year) ?? [];
    if (finiteValues(groupValues).length < 5 || finiteValues(comparisonValues).length < 5) {
      continue;
    }
    observedYears += 1;
    const groupMedian = median(groupValues);
    const comparisonMedian = median(comparisonValues);
    if (
      groupMedian !== null &&
      comparisonMedian !== null &&
      groupMedian < comparisonMedian
    ) {
      stableYears += 1;
    }
  }
  return { stableYears, observedYears };
}

function evaluateGroup(
  definition: FactorDefinition,
  baseJobs: AnalyticsJob[],
  metrics: Map<string, JobMetric>,
): FactorImpact | null {
  const group = baseJobs.filter(definition.matches);
  const comparison = baseJobs.filter((job) => !definition.matches(job));
  if (group.length < 10 || comparison.length < 10) return null;

  const groupRatio = median(group.map((job) => job.reportRatio));
  const comparisonRatio = median(comparison.map((job) => job.reportRatio));
  const groupScore = median(group.map((job) => job.minimumWrittenScore));
  const comparisonScore = median(comparison.map((job) => job.minimumWrittenScore));
  const groupDifficulty = median(
    group.map((job) => metrics.get(job.id)?.difficultyScore ?? null),
  );
  const comparisonDifficulty = median(
    comparison.map((job) => metrics.get(job.id)?.difficultyScore ?? null),
  );
  const scoreCount = group.filter((job) => job.minimumWrittenScore !== null).length;
  const { stableYears, observedYears } = yearlyStability(group, comparison, metrics);
  const difficultyDelta =
    groupDifficulty === null || comparisonDifficulty === null
      ? null
      : groupDifficulty - comparisonDifficulty;
  const ratioDelta =
    groupRatio === null || comparisonRatio === null ? null : groupRatio - comparisonRatio;
  const scoreDelta =
    groupScore === null || comparisonScore === null ? null : groupScore - comparisonScore;
  const confidence = comparisonConfidence(
    group.length,
    comparison.length,
    ratio(scoreCount, group.length),
    stableYears,
  );
  const direction = directionFor(difficultyDelta, ratioDelta);
  return {
    id: definition.id,
    dimension: definition.dimension,
    group: definition.group,
    groupCount: group.length,
    comparisonCount: comparison.length,
    scoreCount,
    scoreCoverage: ratio(scoreCount, group.length),
    medianScore: round(groupScore),
    scoreDelta: round(scoreDelta),
    ratioCount: group.filter((job) => job.reportRatio !== null).length,
    medianRatio: round(groupRatio),
    ratioDelta: round(ratioDelta),
    medianDifficulty: round(groupDifficulty, 1),
    difficultyDelta: round(difficultyDelta, 1),
    direction,
    confidence,
    stableYears,
    observedYears,
    explanation:
      `${definition.group}与其余可报岗位比较；` +
      `难度指数差${difficultyDelta === null ? "无法计算" : `${round(difficultyDelta, 1)}`}，` +
      `缴费报录比中位数差${ratioDelta === null ? "无法计算" : `${round(ratioDelta)}`}。`,
    applyFilter: definition.applyFilter,
  };
}

function recommendationScore(impact: FactorImpact) {
  const difficultyGain = -(impact.difficultyDelta ?? 0);
  const ratioGain =
    impact.ratioDelta !== null && impact.medianRatio
      ? Math.max(0, -impact.ratioDelta / Math.max(impact.medianRatio, 1)) * 20
      : 0;
  const confidenceBonus = impact.confidence === "高" ? 5 : impact.confidence === "中" ? 2 : 0;
  return difficultyGain + ratioGain + confidenceBonus;
}

function combinationFromDefinitions(
  definitions: FactorDefinition[],
  impacts: Map<string, FactorImpact>,
  baseJobs: AnalyticsJob[],
  metrics: Map<string, JobMetric>,
): CombinationRecommendation | null {
  const group = baseJobs.filter((job) => definitions.every((factor) => factor.matches(job)));
  const comparison = baseJobs.filter(
    (job) => !definitions.every((factor) => factor.matches(job)),
  );
  if (group.length < 20 || comparison.length < 20) return null;
  const scoreCoverage = ratio(
    group.filter((job) => job.minimumWrittenScore !== null).length,
    group.length,
  );
  const groupRatio = median(group.map((job) => job.reportRatio));
  const comparisonRatio = median(comparison.map((job) => job.reportRatio));
  const groupDifficulty = median(
    group.map((job) => metrics.get(job.id)?.difficultyScore ?? null),
  );
  const comparisonDifficulty = median(
    comparison.map((job) => metrics.get(job.id)?.difficultyScore ?? null),
  );
  const difficultyDelta =
    groupDifficulty === null || comparisonDifficulty === null
      ? null
      : groupDifficulty - comparisonDifficulty;
  const ratioDelta =
    groupRatio === null || comparisonRatio === null ? null : groupRatio - comparisonRatio;
  if (
    (difficultyDelta === null || difficultyDelta > -2) &&
    (ratioDelta === null || ratioDelta >= 0)
  ) {
    return null;
  }
  const { stableYears, observedYears } = yearlyStability(group, comparison, metrics);
  const confidence = comparisonConfidence(
    group.length,
    comparison.length,
    scoreCoverage,
    stableYears,
  );
  if (confidence === "数据不足") return null;
  const representativeJobIds = [...group]
    .sort(
      (a, b) =>
        (metrics.get(a.id)?.difficultyScore ?? 101) -
        (metrics.get(b.id)?.difficultyScore ?? 101),
    )
    .slice(0, 3)
    .map((job) => job.id);
  return {
    id: definitions.map((factor) => factor.id).join("+"),
    label: definitions
      .map((factor) => `${factor.dimension}：${factor.group}`)
      .join(" ＋ "),
    factors: definitions
      .map((factor) => impacts.get(factor.id))
      .filter((impact): impact is FactorImpact => Boolean(impact)),
    jobCount: group.length,
    scoreCoverage,
    medianRatio: round(groupRatio),
    medianScore: round(median(group.map((job) => job.minimumWrittenScore))),
    medianDifficulty: round(groupDifficulty, 1),
    difficultyDelta: round(difficultyDelta, 1),
    ratioDelta: round(ratioDelta),
    confidence,
    stableYears,
    observedYears,
    representativeJobIds,
    applyFilters: definitions
      .map((factor) => factor.applyFilter)
      .filter((filter): filter is RecommendationFilter => Boolean(filter)),
  };
}

export function analyzeSelection(
  eligibleJobs: AnalyticsJob[],
  currentJobs: AnalyticsJob[],
  metrics: Map<string, JobMetric>,
): SelectionAnalytics {
  const definitions = factorDefinitions(eligibleJobs);
  const factorImpacts = definitions
    .map((definition) => evaluateGroup(definition, eligibleJobs, metrics))
    .filter((impact): impact is FactorImpact => Boolean(impact))
    .sort((a, b) => {
      const aMagnitude = Math.abs(a.difficultyDelta ?? 0) + Math.abs(a.ratioDelta ?? 0) / 5;
      const bMagnitude = Math.abs(b.difficultyDelta ?? 0) + Math.abs(b.ratioDelta ?? 0) / 5;
      return bMagnitude - aMagnitude;
    });
  const impactMap = new Map(factorImpacts.map((impact) => [impact.id, impact]));
  const recommendationDefinitions = definitions
    .filter((definition) => definition.recommendationEligible)
    .filter((definition) => {
      const impact = impactMap.get(definition.id);
      return (
        impact &&
        impact.confidence !== "数据不足" &&
        ((impact.difficultyDelta ?? 0) < -2 || (impact.ratioDelta ?? 0) < 0)
      );
    })
    .sort(
      (a, b) =>
        recommendationScore(impactMap.get(b.id)!) - recommendationScore(impactMap.get(a.id)!),
    )
    .slice(0, 10);

  const combinations: FactorDefinition[][] = recommendationDefinitions.map((factor) => [
    factor,
  ]);
  for (let left = 0; left < recommendationDefinitions.length; left += 1) {
    for (let right = left + 1; right < recommendationDefinitions.length; right += 1) {
      if (
        recommendationDefinitions[left].dimension ===
        recommendationDefinitions[right].dimension
      ) {
        continue;
      }
      combinations.push([
        recommendationDefinitions[left],
        recommendationDefinitions[right],
      ]);
    }
  }

  const recommendations = combinations
    .map((combination) =>
      combinationFromDefinitions(combination, impactMap, eligibleJobs, metrics),
    )
    .filter(
      (recommendation): recommendation is CombinationRecommendation =>
        Boolean(recommendation),
    )
    .sort((a, b) => {
      const aScore =
        -(a.difficultyDelta ?? 0) +
        Math.max(0, -(a.ratioDelta ?? 0)) / 4 +
        (a.confidence === "高" ? 6 : a.confidence === "中" ? 2 : 0);
      const bScore =
        -(b.difficultyDelta ?? 0) +
        Math.max(0, -(b.ratioDelta ?? 0)) / 4 +
        (b.confidence === "高" ? 6 : b.confidence === "中" ? 2 : 0);
      return bScore - aScore;
    })
    .filter(
      (recommendation, index, all) =>
        all.findIndex((item) => item.label === recommendation.label) === index,
    )
    .slice(0, 6);

  return {
    eligible: summarize(eligibleJobs, metrics),
    current: summarize(currentJobs, metrics),
    factorImpacts,
    recommendations,
  };
}

export function formatAnalyticsContext(
  analytics: SelectionAnalytics,
  jobs: AnalyticsJob[],
  metrics: Map<string, JobMetric>,
) {
  const summary = analytics.current;
  const factors = analytics.factorImpacts.map(
    (impact) =>
      `| ${impact.dimension} | ${impact.group} | ${impact.groupCount} | ` +
      `${impact.scoreCount} (${(impact.scoreCoverage * 100).toFixed(0)}%) | ` +
      `${impact.medianScore ?? "—"} | ${impact.scoreDelta ?? "—"} | ` +
      `${impact.medianRatio ?? "—"} | ${impact.ratioDelta ?? "—"} | ` +
      `${impact.medianDifficulty ?? "—"} | ${impact.difficultyDelta ?? "—"} | ` +
      `${impact.stableYears}/${impact.observedYears} | ${impact.confidence} | ${impact.direction} |`,
  );
  const combinations = analytics.recommendations.map(
    (item) =>
      `| ${item.label} | ${item.jobCount} | ${(item.scoreCoverage * 100).toFixed(0)}% | ` +
      `${item.medianRatio ?? "—"} | ${item.medianScore ?? "—"} | ` +
      `${item.medianDifficulty ?? "—"} | ${item.difficultyDelta ?? "—"} | ` +
      `${item.ratioDelta ?? "—"} | ${item.stableYears}/${item.observedYears} | ` +
      `${item.confidence} |`,
  );
  const jobsByDifficulty = [...jobs]
    .sort(
      (a, b) =>
        (metrics.get(a.id)?.difficultyScore ?? 101) -
        (metrics.get(b.id)?.difficultyScore ?? 101),
    );
  const sampleSize = Math.min(20, jobsByDifficulty.length);
  const middleStart = Math.max(
    0,
    Math.floor((jobsByDifficulty.length - sampleSize) / 2),
  );
  const representativeJobs = [
    ...jobsByDifficulty.slice(0, sampleSize),
    ...jobsByDifficulty.slice(middleStart, middleStart + sampleSize),
    ...jobsByDifficulty.slice(-sampleSize),
  ]
    .filter(
      (job, index, all) =>
        all.findIndex((candidate) => candidate.id === job.id) === index,
    )
    .map((job) => {
      const metric = metrics.get(job.id);
      return (
        `| ${job.year} | ${job.city}·${job.district} | ${job.unit}·${job.position} | ` +
        `${job.hires} | ${job.reportRatio ?? "—"} | ${job.minimumWrittenScore ?? "—"} | ` +
        `${metric?.difficultyScore ?? "—"} | ${metric?.confidence ?? "—"} | ` +
        `${job.education}；${job.political}；${job.professionalTest || "未注明"}；` +
        `${job.notes.slice(0, 120).replace(/\|/g, "｜")} | ` +
        `${job.writtenScoreSummary ?? "无可用成绩"} | ` +
        `${job.interviewScoreSummary ?? "无可用成绩"} |`
      );
    });

  return `# 程序预计算的考情分析数据

> 以下统计由查询系统确定性计算完成。请直接解释这些结果，不要重新估算中位数或差值。
> “历史难度指数”是在同年度、同考试类别内，将缴费报录比百分位与最低进面分百分位加权得到，仅用于相对比较，不是上岸概率。

## 范围与覆盖

- 硬性资格范围岗位：${analytics.eligible.jobCount}
- 当前偏好筛选后岗位：${summary.jobCount}
- 招录人数合计：${summary.hires}
- 缴费数据覆盖：${(summary.paymentCoverage * 100).toFixed(1)}%
- 最低进面分覆盖：${(summary.scoreCoverage * 100).toFixed(1)}%
- 面试数据覆盖：${(summary.interviewCoverage * 100).toFixed(1)}%
- 录用数据覆盖：${(summary.admissionCoverage * 100).toFixed(1)}%
- 缴费报录比中位数：${summary.medianRatio ?? "—"}
- 最低进面分中位数：${summary.medianScore ?? "—"}
- 历史难度指数中位数：${summary.medianDifficulty ?? "—"}

## 单条件影响

| 维度 | 分组 | 岗位数 | 分数有效数（覆盖率） | 最低进面分中位数 | 分数差 | 报录比中位数 | 报录比差 | 难度指数 | 难度差 | 有利年度 | 可信度 | 方向 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${factors.join("\n") || "| — | 当前样本无法比较 | 0 | — | — | — | — | — | — | — | — | 数据不足 | 无法比较 |"}

## 程序筛选出的候选条件组合

| 条件组合 | 岗位数 | 分数覆盖率 | 报录比中位数 | 最低进面分中位数 | 难度指数 | 难度差 | 报录比差 | 有利年度 | 可信度 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${combinations.join("\n") || "| 暂无满足样本量与稳定性要求的组合 | 0 | — | — | — | — | — | — | — | 数据不足 |"}

## 代表性岗位

> 以下岗位按历史难度的低、中、高区间均衡抽样，仅用于解释程序统计，不得据此重新估算总体指标。

| 年度 | 地区 | 单位与职位 | 招录 | 报录比 | 最低进面分 | 难度指数 | 数据可信度 | 核心要求与备注 | 笔试成绩分布 | 面试成绩分布 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
${representativeJobs.join("\n")}
`;
}
