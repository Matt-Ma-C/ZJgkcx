export type ScoreProvenance = {
  status: "unknown" | "verified" | "review";
  scoreType?: string | null;
  maximum?: number | null;
  subjects?: string[];
  conversionRule?: string | null;
  comparisonKey?: string | null;
  officialSourceUrl?: string | null;
  sourceVersion?: string | null;
  reviewReasons?: string[];
};

type ScoreComparableJob = {
  scoreProvenance?: ScoreProvenance;
  minimumWrittenScore?: number | null;
  scoreSummary?: { written?: string; interview?: string; rawMinimum?: number | null; rawMaximum?: number | null };
};

function scoreOutOfRange(job: ScoreComparableJob) {
  const maximum = job.scoreProvenance?.maximum;
  if (!Number.isFinite(maximum) || (maximum ?? 0) <= 0) return false;
  const values = [job.minimumWrittenScore, job.scoreSummary?.rawMinimum, job.scoreSummary?.rawMaximum];
  return values.some((value) => value !== null && value !== undefined &&
    (!Number.isFinite(value) || value < 0 || value > maximum!));
}

/** Raw values remain visible; comparison requires source-confirmed scoring metadata. */
export function scoreComparisonKey(job: ScoreComparableJob) {
  const source = job.scoreProvenance;
  if (
    source?.status !== "verified" || !source.scoreType ||
    !Number.isFinite(source.maximum) || (source.maximum ?? 0) <= 0 ||
    !source.subjects?.length || !source.conversionRule ||
    !source.comparisonKey || !/^https?:\/\//.test(source.officialSourceUrl ?? "") ||
    !source.sourceVersion || scoreOutOfRange(job)
  ) return null;
  return JSON.stringify([source.comparisonKey, source.scoreType, source.maximum, [...source.subjects].sort(), source.conversionRule]);
}

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
  scoreProvenance?: ScoreProvenance;
  scoreSummary?: { written?: string; interview?: string; rawMinimum?: number | null; rawMaximum?: number | null };
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
  scoreStatus?: "verified" | "unknown" | "review";
  compositeEligible?: boolean;
  evidenceReasons?: string[];
  ratioCohortSize?: number;
  scoreCohortSize?: number;
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
  comparableScoreCoverage?: number;
  compositeCoverage?: number;
  evidenceNotice?: string;
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
  if (!scoreComparisonKey(job)) return complete >= 0.5 ? "较低" : "数据不足";
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
  const scoreCohortJobs = new Map<string, number>();

  for (const job of jobs) {
    const key = cohortKey(job);
    if (job.reportRatio !== null && Number.isFinite(job.reportRatio) && job.reportRatio >= 0) {
      const cohortValues = ratioByCohort.get(key) ?? [];
      cohortValues.push(job.reportRatio);
      ratioByCohort.set(key, cohortValues);
    }
    const comparison = scoreComparisonKey(job);
    if (comparison) {
      const scoreKey = `${key}|${comparison}`;
      scoreCohortJobs.set(scoreKey, (scoreCohortJobs.get(scoreKey) ?? 0) + 1);
      if (job.minimumWrittenScore === null || !Number.isFinite(job.minimumWrittenScore)) continue;
      const cohortValues = scoreByCohort.get(scoreKey) ?? [];
      cohortValues.push(job.minimumWrittenScore);
      scoreByCohort.set(scoreKey, cohortValues);
    }
  }

  for (const values of [
    ...ratioByCohort.values(),
    ...scoreByCohort.values(),
  ]) {
    values.sort((a, b) => a - b);
  }

  const metrics = new Map<string, JobMetric>();
  for (const job of jobs) {
    const key = cohortKey(job);
    const cohortRatios = ratioByCohort.get(key) ?? [];
    const comparison = scoreComparisonKey(job);
    const scoreKey = `${key}|${comparison}`;
    const cohortScores = comparison ? scoreByCohort.get(scoreKey) ?? [] : [];
    // Never broaden a sparse examination cohort into the entire year's scores.
    const ratioReference = cohortRatios.length >= 20 ? cohortRatios : [];
    const scoreReference = cohortScores.length >= 20 &&
      ratio(cohortScores.length, scoreCohortJobs.get(scoreKey) ?? 0) >= 0.6
      ? cohortScores : [];
    const ratioPercentile =
      job.reportRatio === null || !Number.isFinite(job.reportRatio) || !ratioReference.length
        ? null
        : percentileRank(ratioReference, job.reportRatio);
    const scorePercentile =
      job.minimumWrittenScore === null || !Number.isFinite(job.minimumWrittenScore) || !scoreReference.length
        ? null
        : percentileRank(scoreReference, job.minimumWrittenScore);
    const difficultyScore =
      ratioPercentile !== null && scorePercentile !== null
        ? ratioPercentile * 0.55 + scorePercentile * 0.45
        : null;
    metrics.set(job.id, {
      difficultyScore: round(difficultyScore, 1),
      difficultyBand: difficultyBand(difficultyScore),
      confidence: difficultyScore === null && jobConfidence(job) === "高" ? "中" : jobConfidence(job),
      ratioPercentile: round(ratioPercentile, 1),
      scorePercentile: round(scorePercentile, 1),
      cohortSize: Math.max(ratioReference.length, scoreReference.length),
      completeness: completeness(job),
      scoreStatus: comparison ? "verified" : job.scoreProvenance?.status === "review" || scoreOutOfRange(job) ? "review" : "unknown",
      compositeEligible: difficultyScore !== null,
      ratioCohortSize: cohortRatios.length,
      scoreCohortSize: cohortScores.length,
      evidenceReasons: [
        ...(scoreOutOfRange(job) ? ["已收录笔试原值小于0、非有限数或超过来源标注满分，保留原值待复核，不参与成绩比较"] : []),
        ...(!comparison ? ["成绩类型、满分、科目、折算规则或官方来源尚未核实，原值不参与分差与综合推荐"] : []),
        ...(ratioReference.length ? [] : ["同年度同考试类别报名样本不足20岗"]),
        ...(scoreReference.length || !comparison ? [] : ["同口径成绩样本不足20岗或覆盖低于60%"]),
        ...(job.warnings.length ? ["存在待复核数据提示"] : []),
      ],
    });
  }
  return metrics;
}

function comparableScores(jobs: AnalyticsJob[], minimum = 10) {
  const keys = new Set(jobs.map(scoreComparisonKey).filter(Boolean));
  const values = jobs.filter((job) => scoreComparisonKey(job) && Number.isFinite(job.minimumWrittenScore));
  return keys.size === 1 && values.length >= minimum && ratio(values.length, jobs.length) >= 0.6
    ? values.map((job) => job.minimumWrittenScore) : [];
}

function comparisonHasSameScoreBasis(group: AnalyticsJob[], comparison: AnalyticsJob[]) {
  const keys = new Set([...group, ...comparison].map(scoreComparisonKey).filter(Boolean));
  return keys.size === 1 && comparableScores(group).length > 0 && comparableScores(comparison).length > 0;
}

function supportedDifficulty(jobs: AnalyticsJob[], metrics: Map<string, JobMetric>) {
  const values = finiteValues(jobs.map((job) => metrics.get(job.id)?.difficultyScore));
  return values.length >= 10 && ratio(values.length, jobs.length) >= 0.6 ? median(values) : null;
}

function supportedRatio(jobs: AnalyticsJob[]) {
  const values = finiteValues(jobs.map((job) => job.reportRatio));
  return values.length >= 10 && ratio(values.length, jobs.length) >= 0.6 ? median(values) : null;
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
    medianScore: round(median(comparableScores(jobs))),
    medianDifficulty: round(comparableScores(jobs).length ? supportedDifficulty(jobs, metrics) : null, 1),
    highConfidenceJobs: jobMetrics.filter((metric) => metric.confidence === "高").length,
    comparableScoreCoverage: ratio(jobs.filter((job) => scoreComparisonKey(job) && Number.isFinite(job.minimumWrittenScore)).length, jobs.length),
    compositeCoverage: ratio(jobMetrics.filter((metric) => metric.difficultyScore !== null).length, jobs.length),
    evidenceNotice: "覆盖率仅表示本库收录程度；证据质量不代表预测准确率。口径未核实、混合口径、样本或覆盖不足时不计算成绩优势与综合推荐。",
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
  observedYears = 0,
): ConfidenceLevel {
  if (
    groupCount >= 50 &&
    comparisonCount >= 50 &&
    scoreCoverage >= 0.65 &&
    stableYears >= 2 && observedYears >= 2 && stableYears / observedYears >= 0.75
  ) {
    return "高";
  }
  if (groupCount >= 20 && comparisonCount >= 20 && scoreCoverage >= 0.45) {
    return "中";
  }
  if (groupCount >= 10 && comparisonCount >= 10 && scoreCoverage >= 0.6) return "较低";
  return "数据不足";
}

function directionFor(
  difficultyDelta: number | null,
  ratioDelta: number | null,
) {
  if (difficultyDelta === null && ratioDelta === null) return "无法比较";
  if (difficultyDelta === null) return ratioDelta! < 0 ? "仅报名竞争较低（成绩不可比）" : ratioDelta! > 0 ? "仅报名竞争较高（成绩不可比）" : "报名竞争接近（成绩不可比）";
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
  const overallGroup = supportedDifficulty(group, metrics);
  const overallComparison = supportedDifficulty(comparison, metrics);
  if (overallGroup === null || overallComparison === null) return { stableYears: 0, observedYears: 0 };
  const overallDirection = Math.abs(overallGroup - overallComparison) < 2 ? 0 : Math.sign(overallGroup - overallComparison);
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
      (Math.abs(groupMedian - comparisonMedian) < 2 ? 0 : Math.sign(groupMedian - comparisonMedian)) === overallDirection
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

  const groupRatio = supportedRatio(group);
  const comparisonRatio = supportedRatio(comparison);
  const sameBasis = comparisonHasSameScoreBasis(group, comparison);
  const groupScore = sameBasis ? median(comparableScores(group)) : null;
  const comparisonScore = sameBasis ? median(comparableScores(comparison)) : null;
  const groupDifficulty = sameBasis ? supportedDifficulty(group, metrics) : null;
  const comparisonDifficulty = sameBasis ? supportedDifficulty(comparison, metrics) : null;
  const scoreCount = group.filter((job) => scoreComparisonKey(job) && Number.isFinite(job.minimumWrittenScore)).length;
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
    sameBasis ? Math.min(ratio(scoreCount, group.length), ratio(comparableScores(comparison).length, comparison.length)) : 0,
    stableYears,
    observedYears,
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
      `${definition.group}与其余筛选范围岗位比较；` +
      `难度指数差${difficultyDelta === null ? "无法计算" : `${round(difficultyDelta, 1)}`}，` +
      `缴费报录比中位数差${ratioDelta === null ? "无法计算" : `${round(ratioDelta)}`}。` +
      (!sameBasis ? "成绩口径、样本或双方覆盖不足，停止成绩差与综合推荐；报名竞争仅作独立描述。" : "证据质量描述历史资料，不代表预测准确率。"),
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
  if (!comparisonHasSameScoreBasis(group, comparison)) return null;
  const scoreCoverage = ratio(
    group.filter((job) => scoreComparisonKey(job) && Number.isFinite(job.minimumWrittenScore)).length,
    group.length,
  );
  const groupRatio = supportedRatio(group);
  const comparisonRatio = supportedRatio(comparison);
  const groupDifficulty = supportedDifficulty(group, metrics);
  const comparisonDifficulty = supportedDifficulty(comparison, metrics);
  if (groupDifficulty === null || comparisonDifficulty === null || groupRatio === null || comparisonRatio === null) return null;
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
    Math.min(scoreCoverage, ratio(comparableScores(comparison).length, comparison.length)),
    stableYears,
    observedYears,
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
    medianScore: round(median(comparableScores(group))),
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
> 报名竞争、成绩门槛和资料完整度分别描述。综合指数只在同年度、同考试类别、来源已核实且计分口径相同的组内，以55%报名竞争分位和45%成绩分位计算；缺一项时不计算，不回退全年口径。它描述历史相对位置，不是上岸概率。
> 成绩原值未核实满分、科目或折算方式时只保留展示，不能换算、比较分数优势或进入综合推荐。允许无足够证据推荐。证据质量不是预测准确率；年度一致性同时适用于有利与不利方向。

## 范围与覆盖

- 待逐项核验的检索范围岗位：${analytics.eligible.jobCount}
- 当前偏好筛选后岗位：${summary.jobCount}
- 招录人数合计：${summary.hires}
- 缴费数据覆盖：${(summary.paymentCoverage * 100).toFixed(1)}%
- 最低进面分覆盖：${(summary.scoreCoverage * 100).toFixed(1)}%
- 已确认可比口径成绩覆盖：${((summary.comparableScoreCoverage ?? 0) * 100).toFixed(1)}%
- 完整综合指标覆盖：${((summary.compositeCoverage ?? 0) * 100).toFixed(1)}%
- 面试数据覆盖：${(summary.interviewCoverage * 100).toFixed(1)}%
- 录用数据覆盖：${(summary.admissionCoverage * 100).toFixed(1)}%
- 缴费报录比中位数：${summary.medianRatio ?? "—"}
- 最低进面分中位数：${summary.medianScore ?? "—"}
- 历史难度指数中位数：${summary.medianDifficulty ?? "—"}

## 单条件影响

| 维度 | 分组 | 岗位数 | 可比成绩数（覆盖率） | 同口径成绩中位数 | 分数差 | 报录比中位数 | 报录比差 | 完整综合指数 | 指数差 | 同向年度/可观察年度 | 证据质量 | 方向 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${factors.join("\n") || "| — | 当前样本无法比较 | 0 | — | — | — | — | — | — | — | — | 数据不足 | 无法比较 |"}

## 程序筛选出的候选条件组合

| 条件组合 | 岗位数 | 可比成绩覆盖率 | 报录比中位数 | 同口径成绩中位数 | 完整综合指数 | 指数差 | 报录比差 | 同向年度/可观察年度 | 证据质量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${combinations.join("\n") || "| 暂无满足样本量与稳定性要求的组合 | 0 | — | — | — | — | — | — | — | 数据不足 |"}

## 代表性岗位

> 以下岗位按历史难度的低、中、高区间均衡抽样，仅用于解释程序统计，不得据此重新估算总体指标。

| 年度 | 地区 | 单位与职位 | 招录 | 报录比 | 最低进面分 | 难度指数 | 数据可信度 | 核心要求与备注 | 笔试成绩分布 | 面试成绩分布 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
${representativeJobs.join("\n")}
`;
}
