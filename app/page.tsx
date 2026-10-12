"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import RegionMap from "./region-map";
import { sortJobs, type SortField, type SortOrder } from "./job-sort";
import { minimumAdmittedWrittenScore } from "./admission-score";
import remarkGfm from "remark-gfm";
import {
  formatAnalyticsContext,
  type AnalyticsJob,
  type CombinationRecommendation,
  type JobMetric,
  type SelectionAnalytics,
} from "./analytics";

type Person = {
  name: string;
  ticket: string;
  writtenScore: number | null;
  writtenRank: number | null;
  interviewScore: number | null;
  professionalScore: number | null;
  totalScore: number | null;
  rank: number | null;
  interviewNote: string;
  sourceType: string;
};

type AdmittedPerson = {
  name: string;
  gender: string;
  ticket: string;
  schoolOrEmployer: string;
};

type Job = {
  id: string;
  year: number;
  city: string;
  district: string;
  categorySheet: string;
  unit: string;
  code: string;
  position: string;
  jobProperty: string;
  bigCategory: string;
  subCategory: string;
  hires: number;
  phone: string;
  description: string;
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
  paymentCount: number | null;
  reportRatio: number | null;
  minimumWrittenScore: number | null;
  interviewees: Person[];
  admitted: AdmittedPerson[];
  sources: {
    job: string;
    payment: string;
    entry: string[];
    interview: string[];
    admission: string[];
  };
  warnings: string[];
};

type Options = {
  years: number[];
  cities: string[];
  districtsByCity: Record<string, string[]>;
  education: string[];
  identity: string[];
  political: string[];
  ethnicity: string[];
  age: string[];
  psychologicalTest: string[];
  physicalTest: string[];
  professionalTest: string[];
};

type Payload = {
  meta: {
    title: string;
    scope: string;
    generatedAt: string;
    notice: string;
    stats: {
      jobCount: number;
      byYear: Record<string, number>;
      paymentMatchedJobs: number;
      jobsWithInterviewees: number;
      intervieweeCount: number;
      jobsWithAdmissions: number;
      admittedCount: number;
      generatedFromFiles: number;
    };
  };
  options: Options;
  jobs: Job[];
};

type MultiFilterKey =
  | "year"
  | "district"
  | "education"
  | "degree"
  | "identity"
  | "political"
  | "ethnicity"
  | "age"
  | "bigCategory"
  | "psychologicalTest"
  | "physicalTest"
  | "professionalTest";

type Filters = Record<MultiFilterKey, string[]> & {
  city: string;
  majors: string;
  notes: string;
  policeScope: "all" | "only" | "exclude";
};

const createEmptyFilters = (): Filters => ({
  year: [],
  district: [],
  education: [],
  degree: [],
  identity: [],
  political: [],
  ethnicity: [],
  age: [],
  bigCategory: [],
  psychologicalTest: [],
  physicalTest: [],
  professionalTest: [],
  city: "",
  majors: "",
  notes: "",
  policeScope: "all",
});

const normalizeIdentity = (value: string) => /^202[456]年应届毕业生$/.test(value) ? "当年应届毕业生" : value;

const PAGE_SIZE = 20;
const ANALYSIS_JOB_LIMIT = 15_000;

const emptySummary: SelectionAnalytics["eligible"] = {
  jobCount: 0,
  hires: 0,
  paymentCoverage: 0,
  scoreCoverage: 0,
  interviewCoverage: 0,
  admissionCoverage: 0,
  medianRatio: null,
  medianScore: null,
  medianDifficulty: null,
  highConfidenceJobs: 0,
};

const createEmptyAnalytics = (): SelectionAnalytics => ({
  eligible: { ...emptySummary },
  current: { ...emptySummary },
  factorImpacts: [],
  recommendations: [],
});

function toAnalyticsJob(job: Job, includeScoreDistribution = false): AnalyticsJob {
  const { interviewees, admitted, ...fields } = job;
  return {
    ...fields,
    identity: normalizeIdentity(job.identity),
    intervieweeCount: interviewees.length,
    admittedCount: admitted.length,
    ...(includeScoreDistribution
      ? {
          writtenScoreSummary: scoreDistribution(
            interviewees.map((person) => person.writtenScore),
          ),
          interviewScoreSummary: scoreDistribution(
            interviewees.map((person) => person.interviewScore),
          ),
        }
      : {}),
  };
}

function formatValue(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function formatRatio(value: number | null) {
  if (value === null) return "—";
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} : 1`;
}

function isPoliceJob(job: Job) {
  const text = [
    job.unit,
    job.position,
    job.description,
    job.jobProperty,
    job.bigCategory,
    job.subCategory,
  ].join(" ");
  return /公安|人民警察|司法警察|特警/.test(text);
}

function formatScore(value: number) {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "");
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number | null, suffix = "") {
  if (value === null) return "—";
  const formatted = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted}${suffix}`;
}

function percentile(sortedValues: number[], fraction: number) {
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (position - lower)
  );
}

function scoreDistribution(values: Array<number | null>) {
  const scores = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!scores.length) return "无可用成绩";
  const average = scores.reduce((total, value) => total + value, 0) / scores.length;
  return [
    `n=${scores.length}`,
    `最低 ${formatScore(scores[0])}`,
    `P25 ${formatScore(percentile(scores, 0.25))}`,
    `中位 ${formatScore(percentile(scores, 0.5))}`,
    `均值 ${formatScore(average)}`,
    `P75 ${formatScore(percentile(scores, 0.75))}`,
    `最高 ${formatScore(scores[scores.length - 1])}`,
  ].join("；");
}

function escapeMarkdown(value: string | number | null | undefined) {
  return formatValue(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function summarizeFilters(filters: Filters) {
  const labels: Array<[string, string[] | string]> = [
    ["年度", filters.year],
    ["设区市", filters.city],
    ["区县", filters.district],
    ["学历", filters.education],
    ["学位", filters.degree],
    ["现有身份", filters.identity],
    ["政治面貌", filters.political],
    ["民族", filters.ethnicity],
    ["年龄", filters.age],
    ["考试类别", filters.bigCategory],
    ["心理测评", filters.psychologicalTest],
    ["体能测试", filters.physicalTest],
    ["专业加试", filters.professionalTest],
    [
      "公安岗位",
      filters.policeScope === "only"
        ? "仅公安岗位"
        : filters.policeScope === "exclude"
          ? "排除公安岗位"
          : "",
    ],
    ["专业关键词", filters.majors],
    ["备注关键词", filters.notes],
  ];
  const active = labels
    .map(([label, value]) => {
      const text = Array.isArray(value) ? value.join("、") : value.trim();
      return text ? `${label}：${text}` : "";
    })
    .filter(Boolean);
  return active.length ? active.join("；") : "未设置筛选条件（全部岗位）";
}

function buildJobsMarkdown(
  jobs: Job[],
  filters: Filters,
  metrics?: Map<string, JobMetric>,
) {
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const rows = jobs.map((job) => {
    const region =
      job.city === "省级机关" ? "省级机关" : `${job.city} · ${job.district}`;
    const unitAndPosition = `${job.unit}<br>${job.position}<br>职位代码：${job.code}`;
    const requirements = [
      `学历：${formatValue(job.education)}`,
      `学位：${formatValue(job.degree)}`,
      `身份：${formatValue(job.identity)}`,
      `政治面貌：${formatValue(job.political)}`,
      `民族：${formatValue(job.ethnicity)}`,
      `年龄：${formatValue(job.age)}`,
      `专业：${formatValue(job.majors)}`,
      `心理测评：${formatValue(job.psychologicalTest)}`,
      `体能测试：${formatValue(job.physicalTest)}`,
      `专业加试：${formatValue(job.professionalTest)}`,
      `备注：${formatValue(job.notes)}`,
    ].join("<br>");
    const distribution = [
      `笔试：${scoreDistribution(job.interviewees.map((person) => person.writtenScore))}`,
      `面试：${scoreDistribution(job.interviewees.map((person) => person.interviewScore))}`,
    ].join("<br>");
    const metric = metrics?.get(job.id);
    const difficulty = metric
      ? `${metric.difficultyBand}（${metric.difficultyScore ?? "—"}；可信度${metric.confidence}）`
      : "—";
    return `| ${job.year} | ${escapeMarkdown(region)} | ${escapeMarkdown(unitAndPosition)} | ${escapeMarkdown(requirements)} | ${job.hires} | ${escapeMarkdown(job.paymentCount)} | ${escapeMarkdown(formatRatio(job.reportRatio))} | ${escapeMarkdown(job.minimumWrittenScore)} | ${escapeMarkdown(difficulty)} | ${escapeMarkdown(distribution)} |`;
  });

  return `# 浙江公务员岗位考情数据

- 导出时间：${generatedAt}
- 岗位数量：${jobs.length}
- 当前筛选：${summarizeFilters(filters)}
- 口径说明：报录比 = 缴费人数 ÷ 招录人数；成绩分布基于该岗位已关联的面试人员记录。
- 使用建议：可将本文提供给大模型，要求比较地区、资格限制、备注限制、报录比和进面分数，并关注样本量与数据缺失。

| 年度 | 地区 | 招录单位与职位 | 核心要求与备注 | 招录 | 缴费 | 报录比 | 最低进面分 | 历史难度与可信度 | 参加面试人员的笔试和面试成绩分布 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${rows.join("\n")}
`;
}

function selectedLabel(values: string[]) {
  if (!values.length) return "全部";
  if (values.length <= 2) return values.join("、");
  return `${values[0]} 等 ${values.length} 项`;
}

function MultiSelectField({
  label,
  values,
  options,
  onChange,
  disabled = false,
  emptyText = "全部",
}: {
  label: string;
  values: string[];
  options: Array<string | number>;
  onChange: (values: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        !details.contains(event.target)
      ) {
        details.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const toggle = (option: string) => {
    onChange(
      values.includes(option)
        ? values.filter((value) => value !== option)
        : [...values, option],
    );
  };

  return (
    <div className="field">
      <span>{label}</span>
      <details
        ref={detailsRef}
        className={`multi-select${disabled ? " is-disabled" : ""}`}
      >
        <summary
          aria-disabled={disabled}
          onClick={(event) => disabled && event.preventDefault()}
        >
          <span className={values.length ? "has-value" : ""}>
            {values.length ? selectedLabel(values) : emptyText}
          </span>
          {values.length > 0 && <b>{values.length}</b>}
          <i>⌄</i>
        </summary>
        <div className="multi-menu">
          <div className="multi-menu-head">
            <span>可多选</span>
            <button type="button" onClick={() => onChange([])} disabled={!values.length}>
              清空
            </button>
          </div>
          <div className="multi-options">
            {options.map((option) => {
              const value = String(option);
              return (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={values.includes(value)}
                    onChange={() => toggle(value)}
                  />
                  <span>{value}</span>
                </label>
              );
            })}
          </div>
        </div>
      </details>
    </div>
  );
}

function DetailDrawer({
  job,
  metric,
  onClose,
}: {
  job: Job;
  metric?: JobMetric;
  onClose: () => void;
}) {
  const admittedTickets = useMemo(
    () => new Set(job.admitted.map((person) => person.ticket)),
    [job.admitted],
  );
  const hasProfessionalScore = job.interviewees.some(
    (person) => person.professionalScore !== null,
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("drawer-open");
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("drawer-open");
    };
  }, [onClose]);

  const details = [
    ["设区市", job.city],
    ["区县", job.district],
    ["招录单位", job.unit],
    ["职位名称", job.position],
    ["职位代码", job.code],
    ["职位属性", job.jobProperty],
    ["职位大类", job.bigCategory],
    ["职位小类", job.subCategory],
    ["招录人数", job.hires],
    ["咨询电话", job.phone],
    ["职位简介", job.description],
    ["学历要求", job.education],
    ["学位要求", job.degree],
    ["现有身份要求", job.identity],
    ["政治面貌要求", job.political],
    ["民族要求", job.ethnicity],
    ["年龄要求", job.age],
    ["专业要求", job.majors],
    ["加试心理测评", job.psychologicalTest],
    ["体能测试", job.physicalTest],
    ["专业加试", job.professionalTest],
    ["备注", job.notes],
  ];

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${job.position}岗位详情`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <div className="eyebrow-row">
              <span className="year-pill">{job.year}</span>
              <span>
                {job.city === "省级机关"
                  ? "省级机关"
                  : `${job.city} · ${job.district}`}
              </span>
              <span>职位代码 {job.code}</span>
            </div>
            <h2>{job.position}</h2>
            <p>{job.unit}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭岗位详情">
            ×
          </button>
        </header>

        <div className="drawer-content">
          {job.warnings.length > 0 && (
            <div className="warning-box">
              <strong>数据提示</strong>
              <span>{job.warnings.join("；")}</span>
            </div>
          )}

          <section className="metric-grid">
            <div>
              <span>招录人数</span>
              <strong>{job.hires}</strong>
              <small>人</small>
            </div>
            <div>
              <span>缴费人数</span>
              <strong>{formatValue(job.paymentCount)}</strong>
              <small>人</small>
            </div>
            <div>
              <span>报录比</span>
              <strong>{formatRatio(job.reportRatio)}</strong>
              <small>缴费 ÷ 招录</small>
            </div>
            <div className="accent-metric">
              <span>最低进面分</span>
              <strong>{formatValue(job.minimumWrittenScore)}</strong>
              <small>笔试成绩</small>
            </div>
            <div>
              <span>进面人数</span>
              <strong>{job.interviewees.length}</strong>
              <small>人</small>
            </div>
            <div>
              <span>历史难度</span>
              <strong>{metric?.difficultyScore ?? "—"}</strong>
              <small>
                {metric?.difficultyBand ?? "暂无判断"} · {metric?.confidence ?? "数据不足"}
              </small>
            </div>
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <div>
                <span className="section-number">01</span>
                <h3>岗位与报考要求</h3>
              </div>
              <p>岗位表字段完整呈现</p>
            </div>
            <dl className="details-grid">
              {details.map(([label, value]) => (
                <div
                  key={String(label)}
                  className={
                    ["招录单位", "职位简介", "专业要求", "备注"].includes(String(label))
                      ? "detail-wide"
                      : ""
                  }
                >
                  <dt>{label}</dt>
                  <dd>{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <div>
                <span className="section-number">02</span>
                <h3>参加面试人员</h3>
              </div>
              <p>共 {job.interviewees.length} 人</p>
            </div>
            {job.interviewees.length ? (
              <div className="table-scroll">
                <table className="people-table">
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>准考证号</th>
                      <th>笔试成绩</th>
                      <th>笔试排名</th>
                      <th>面试成绩</th>
                      {hasProfessionalScore && <th>专业测试</th>}
                      <th>总成绩</th>
                      <th>总排名</th>
                      <th>结果/备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.interviewees.map((person) => (
                      <tr key={person.ticket}>
                        <td>
                          <strong>{person.name}</strong>
                          {admittedTickets.has(person.ticket) && (
                            <span className="admitted-tag">已录用</span>
                          )}
                        </td>
                        <td className="mono">{person.ticket}</td>
                        <td>{formatValue(person.writtenScore)}</td>
                        <td>{formatValue(person.writtenRank)}</td>
                        <td>{formatValue(person.interviewScore)}</td>
                        {hasProfessionalScore && (
                          <td>{formatValue(person.professionalScore)}</td>
                        )}
                        <td>{formatValue(person.totalScore)}</td>
                        <td>{formatValue(person.rank)}</td>
                        <td>{formatValue(person.interviewNote)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-panel">该岗位未在已下载的进面或总成绩文件中匹配到人员。</div>
            )}
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <div>
                <span className="section-number">03</span>
                <h3>最终录用人员</h3>
              </div>
              <p>共 {job.admitted.length} 人</p>
            </div>
            {job.admitted.length ? (
              <div className="admission-list">
                {job.admitted.map((person) => (
                  <article key={`${person.ticket}-${person.name}`}>
                    <div className="avatar">{person.name.slice(-1)}</div>
                    <div>
                      <div className="admission-name">
                        <strong>{person.name}</strong>
                        <span>拟录用</span>
                      </div>
                      <p>
                        {formatValue(person.gender)} · 准考证号{" "}
                        <span className="mono">{person.ticket}</span>
                      </p>
                      <small>{formatValue(person.schoolOrEmployer)}</small>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-panel">该岗位未在已下载的最终录用名单中匹配到人员。</div>
            )}
          </section>

          <details className="source-details">
            <summary>查看数据来源文件</summary>
            <div>
              <p>
                <strong>岗位表：</strong>
                {formatValue(job.sources.job)}
              </p>
              <p>
                <strong>缴费表：</strong>
                {formatValue(job.sources.payment)}
              </p>
              <p>
                <strong>进面表：</strong>
                {job.sources.entry.join("；") || "—"}
              </p>
              <p>
                <strong>总成绩表：</strong>
                {job.sources.interview.join("；") || "—"}
              </p>
              <p>
                <strong>录用名单：</strong>
                {job.sources.admission.join("；") || "—"}
              </p>
            </div>
          </details>
        </div>
      </aside>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Filters>(createEmptyFilters);
  const [mapQueryId, setMapQueryId] = useState(0);
  const [applied, setApplied] = useState<Filters>(createEmptyFilters);
  const [sortField, setSortField] = useState<SortField>("hires");
  const [sortOrder, setSortOrder] = useState<SortOrder>("default");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Job | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [analysisModel, setAnalysisModel] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hiddenJobIds, setHiddenJobIds] = useState<Set<string>>(() => new Set());
  const [considerPoliceJobs, setConsiderPoliceJobs] = useState(true);
  const [jobMetrics, setJobMetrics] = useState<Map<string, JobMetric>>(
    () => new Map(),
  );
  const [selectionAnalytics, setSelectionAnalytics] =
    useState<SelectionAnalytics>(createEmptyAnalytics);
  const [isLocalAnalysisLoading, setIsLocalAnalysisLoading] = useState(false);
  const [localAnalysisError, setLocalAnalysisError] = useState("");
  const analyticsWorkerRef = useRef<Worker | null>(null);
  const analyticsRequestId = useRef(0);

  useEffect(() => {
    fetch("/data/jobs.json")
      .then((response) => {
        if (!response.ok) throw new Error("数据文件读取失败");
        return response.json() as Promise<Payload>;
      })
      .then(setData)
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(() => {
    if (!data) return;
    const worker = new Worker(new URL("./analytics-worker.ts", import.meta.url), {
      type: "module",
    });
    analyticsWorkerRef.current = worker;
    worker.onmessage = (
      event: MessageEvent<
        | { type: "metrics"; entries: Array<[string, JobMetric]> }
        | { type: "started"; requestId: number }
        | {
            type: "analysis";
            requestId: number;
            analytics: SelectionAnalytics;
          }
      >,
    ) => {
      if (event.data.type === "metrics") {
        setJobMetrics(new Map(event.data.entries));
        return;
      }
      if (event.data.type === "started") {
        if (event.data.requestId !== analyticsRequestId.current) return;
        setIsLocalAnalysisLoading(true);
        setLocalAnalysisError("");
        return;
      }
      if (event.data.requestId !== analyticsRequestId.current) return;
      setSelectionAnalytics(event.data.analytics);
      setIsLocalAnalysisLoading(false);
    };
    worker.onerror = () => {
      setIsLocalAnalysisLoading(false);
      setLocalAnalysisError(
        "本地统计计算未能完成。岗位查询仍可使用，请刷新页面后重试。",
      );
    };
    worker.postMessage({
      type: "init",
      jobs: data.jobs.map(toAnalyticsJob),
    });
    return () => {
      worker.terminate();
      analyticsWorkerRef.current = null;
    };
  }, [data]);

  const updateMulti = (key: MultiFilterKey, values: string[]) => {
    setDraft((current) => ({ ...current, [key]: values }));
  };

  const matchMulti = (selectedValues: string[], value: string | number) =>
    selectedValues.length === 0 || selectedValues.includes(String(value));

  const degreeOptions = useMemo(
    () =>
      data
        ? [...new Set(data.jobs.map((job) => job.degree).filter(Boolean))].sort(
            (a, b) => a.localeCompare(b, "zh-CN"),
          )
        : [],
    [data],
  );

  const bigCategoryOptions = useMemo(
    () =>
      data
        ? [
            ...new Set(
              data.jobs
                .map((job) => job.bigCategory || job.jobProperty)
                .filter(Boolean),
            ),
          ].sort((a, b) => a.localeCompare(b, "zh-CN"))
        : [],
    [data],
  );

  const eligibleJobs = useMemo(() => {
    if (!data) return [];
    const majorKeyword = applied.majors.trim().toLowerCase();
    return data.jobs.filter(
      (job) =>
        matchMulti(applied.year, job.year) &&
        matchMulti(applied.education, job.education) &&
        matchMulti(applied.degree, job.degree) &&
        matchMulti(applied.identity, normalizeIdentity(job.identity)) &&
        matchMulti(applied.political, job.political) &&
        matchMulti(applied.ethnicity, job.ethnicity) &&
        matchMulti(applied.age, job.age) &&
        (!majorKeyword || job.majors.toLowerCase().includes(majorKeyword)),
    );
  }, [applied, data]);

  const filteredJobs = useMemo(() => {
    const noteKeyword = applied.notes.trim().toLowerCase();
    const matches = eligibleJobs.filter(
      (job) =>
        (!applied.city || applied.city === job.city) &&
        matchMulti(applied.district, job.district) &&
        matchMulti(applied.bigCategory, job.bigCategory || job.jobProperty) &&
        matchMulti(applied.psychologicalTest, job.psychologicalTest) &&
        matchMulti(applied.physicalTest, job.physicalTest) &&
        matchMulti(applied.professionalTest, job.professionalTest) &&
        (!noteKeyword || job.notes.toLowerCase().includes(noteKeyword)) &&
        (applied.policeScope === "all" ||
          (applied.policeScope === "only" && isPoliceJob(job)) ||
          (applied.policeScope === "exclude" && !isPoliceJob(job))),
    );

    return sortJobs(matches, sortField, sortOrder);
  }, [applied, eligibleJobs, sortField, sortOrder]);

  const availableJobs = useMemo(
    () => filteredJobs.filter((job) => !hiddenJobIds.has(job.id)),
    [filteredJobs, hiddenJobIds],
  );
  const hiddenFilteredCount = filteredJobs.length - availableJobs.length;
  const analyticsEligibleJobs = useMemo(
    () =>
      eligibleJobs.filter(
        (job) =>
          !hiddenJobIds.has(job.id) && (considerPoliceJobs || !isPoliceJob(job)),
      ),
    [considerPoliceJobs, eligibleJobs, hiddenJobIds],
  );
  const analysisJobs = useMemo(
    () =>
      considerPoliceJobs
        ? availableJobs
        : availableJobs.filter((job) => !isPoliceJob(job)),
    [availableJobs, considerPoliceJobs],
  );
  const excludedPoliceCount = availableJobs.length - analysisJobs.length;
  useEffect(() => {
    const worker = analyticsWorkerRef.current;
    if (!worker) return;
    analyticsRequestId.current += 1;
    const requestId = analyticsRequestId.current;
    worker.postMessage({
      type: "analyze",
      requestId,
      eligibleIds: analyticsEligibleJobs.map((job) => job.id),
      currentIds: analysisJobs.map((job) => job.id),
    });
  }, [analysisJobs, analyticsEligibleJobs]);
  const displayedFactorImpacts = useMemo(() => {
    const preferredDimensions = [
      "政治面貌",
      "学历要求",
      "学位要求",
      "现有身份",
      "民族要求",
      "年龄要求",
      "专业门类",
      "心理测评",
      "体能测试",
      "专业加试",
      "备注限制",
    ];
    const selected = selectionAnalytics.factorImpacts.slice(0, 14);
    const ids = new Set(selected.map((impact) => impact.id));
    for (const dimension of preferredDimensions) {
      const representative = selectionAnalytics.factorImpacts.find(
        (impact) => impact.dimension === dimension && !ids.has(impact.id),
      );
      if (representative) {
        selected.push(representative);
        ids.add(representative.id);
      }
    }
    return selected.slice(0, 22);
  }, [selectionAnalytics.factorImpacts]);
  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / PAGE_SIZE));
  const visibleJobs = filteredJobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const multiKeys: MultiFilterKey[] = [
    "year",
    "district",
    "education",
    "degree",
    "identity",
    "political",
    "ethnicity",
    "age",
    "bigCategory",
    "psychologicalTest",
    "physicalTest",
    "professionalTest",
  ];
  const activeFilterCount =
    multiKeys.reduce((total, key) => total + applied[key].length, 0) +
    (applied.city ? 1 : 0) +
    (applied.majors ? 1 : 0) +
    (applied.notes ? 1 : 0) +
    (applied.policeScope !== "all" ? 1 : 0);

  const applyFilters = () => {
    setMapQueryId((id) => id + 1);
    setApplied({ ...draft });
    requestAnimationFrame(() => document.getElementById("region-map-title")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    setPage(1);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const resetFilters = () => {
    const empty = createEmptyFilters();
    setDraft(empty);
    setMapQueryId((id) => id + 1);
    setApplied(createEmptyFilters());
    setPage(1);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const toggleHiddenJob = (jobId: string) => {
    setHiddenJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const restoreHiddenJobs = () => {
    setHiddenJobIds(new Set());
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const updatePoliceScope = (value: boolean) => {
    setConsiderPoliceJobs(value);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const applyRecommendation = (recommendation: CombinationRecommendation) => {
    const next: Filters = {
      ...applied,
      city: "",
      district: [],
      bigCategory: [],
      psychologicalTest: [],
      physicalTest: [],
      professionalTest: [],
      notes: "",
      policeScope: "all",
    };
    for (const filter of recommendation.applyFilters) {
      if (filter.key === "city") {
        next.city = filter.value;
        next.district = [];
      } else if (filter.key === "policeScope") {
        next.policeScope = filter.value as Filters["policeScope"];
      } else {
        next[filter.key] = [filter.value];
      }
    }
    setDraft(next);
    setMapQueryId((id) => id + 1);
    setApplied(next);
    setPage(1);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
    document.getElementById("results-title")?.scrollIntoView({ behavior: "smooth" });
  };

  const exportMarkdown = () => {
    if (!availableJobs.length) return;
    const markdown = buildJobsMarkdown(availableJobs, applied, jobMetrics);
    const blob = new Blob(["\uFEFF", markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const scope = (applied.city || "浙江全省").replace(/[\\/:*?"<>|]/g, "");
    link.href = url;
    link.download = `浙江公务员考情_${scope}_${availableJobs.length}个岗位.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const analyzeWithDeepSeek = async () => {
    setAnalysisError("");
    if (isLocalAnalysisLoading) {
      setAnalysis("");
      setAnalysisError("本地考情统计仍在计算，请完成后再发起 AI 分析。");
      return;
    }
    if (!analysisJobs.length) {
      setAnalysis("");
      setAnalysisError(
        availableJobs.length
          ? "排除公安岗位后没有可供分析的岗位，不会发起 API 调用。"
          : "当前没有未隐藏的岗位，不会发起 API 调用。",
      );
      return;
    }
    if (analysisJobs.length > ANALYSIS_JOB_LIMIT) {
      setAnalysis("");
      setAnalysisError(
        `当前有 ${analysisJobs.length} 个待分析岗位。为控制费用并避免上下文超限，请先筛选或隐藏至 ${ANALYSIS_JOB_LIMIT} 个以内。`,
      );
      return;
    }
    if (!apiKey.trim()) {
      setAnalysisError("请先输入 DeepSeek API Key。");
      return;
    }

    setIsAnalyzing(true);
    setAnalysis("");
    setAnalysisModel("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          jobCount: analysisJobs.length,
          jobMarkdown:
            `# 用户当前条件\n\n${summarizeFilters(applied)}\n\n` +
            formatAnalyticsContext(
              selectionAnalytics,
              analysisJobs.map((job) => toAnalyticsJob(job, true)),
              jobMetrics,
            ),
          considerPoliceJobs,
        }),
      });
      const result = (await response.json()) as {
        analysis?: string;
        error?: string;
        model?: string;
      };
      if (!response.ok || !result.analysis) {
        throw new Error(result.error || "DeepSeek 没有返回有效分析。");
      }
      setAnalysis(result.analysis);
      setAnalysisModel(result.model || "");
    } catch (error) {
      setAnalysisError(
        error instanceof Error ? error.message : "分析请求失败，请稍后重试。",
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (loadError) {
    return (
      <main className="status-screen">
        <strong>数据加载失败</strong>
        <p>{loadError}。请使用项目提供的启动脚本运行系统。</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="status-screen loading-screen">
        <div className="loading-mark">浙</div>
        <strong>正在载入考情数据</strong>
        <p>正在整理岗位、成绩与录用名单…</p>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="岗查查首页">
            <span className="brand-mark brand-icon" aria-hidden="true" />
            <span>
              <strong>岗查查</strong>
              <small>浙江全省 · 2024—2026</small>
            </span>
          </a>
          <div className="topbar-meta">
            <span className="status-dot" />
            本地数据已载入
            <span className="meta-divider" />
            {data.meta.stats.generatedFromFiles} 份官方文件
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-inner">
          <div className="hero-copy">
            <span className="kicker">2024—2026 浙江全省公务员招录数据</span>
            <h1>岗查查</h1>
            <p>岗位要求、报名热度、进面分数与录用结果，一处查清。</p>
          </div>
          <div className="hero-stats">
            <div>
              <strong>{data.meta.stats.jobCount.toLocaleString("zh-CN")}</strong>
              <span>个招录岗位</span>
            </div>
            <div>
              <strong>{data.meta.stats.intervieweeCount.toLocaleString("zh-CN")}</strong>
              <span>条进面记录</span>
            </div>
            <div>
              <strong>{data.meta.stats.admittedCount.toLocaleString("zh-CN")}</strong>
              <span>条录用记录</span>
            </div>
          </div>
        </div>
      </section>

      <nav className="module-nav" aria-label="模块导航">
          <a href="#filter-title" aria-label="01报考条件"><span className="module-nav-number">01</span><span>报考</span><span>条件</span></a>
          <a href="#region-map-title" aria-label="02岗位地图"><span className="module-nav-number">02</span><span>岗位</span><span>地图</span></a>
          <a href="#results-title" aria-label="03岗位明细"><span className="module-nav-number">03</span><span>岗位</span><span>明细</span></a>
          <a href="#insight-title" aria-label="04考情分析"><span className="module-nav-number">04</span><span>考情</span><span>分析</span></a>
          <a href="#analysis-title" aria-label="05选岗分析"><span className="module-nav-number">05</span><span>选岗</span><span>分析</span></a>
        </nav>
        <div className="workspace">
        <section className="filter-card" aria-labelledby="filter-title">
          <div className="filter-heading">
            <div>
              <span className="panel-index">01</span>
              <h2 id="filter-title">报考条件</h2>
            </div>
          <div className="filter-actions">
            <button className="ghost-button" onClick={resetFilters}>
              重置条件
            </button>
            <button className="primary-button" onClick={applyFilters}>
              查询岗位
            </button>
          </div>
          </div>
          <div className="filter-description">
            <p>先确定岗位要求，再用策略偏好缩小范围</p>
            {activeFilterCount > 0 && (
              <span className="active-count">已应用 {activeFilterCount} 项</span>
            )}
          </div>
          <div className="filter-grid">
            <div className="filter-group-title">
              <strong>岗位要求</strong>
              <span>选择年度及本人资格条件，确定可报岗位范围</span>
            </div>
            <MultiSelectField
              label="年度"
              values={draft.year}
              options={data.options.years}
              onChange={(values) => updateMulti("year", values)}
            />
<MultiSelectField
              label="学历要求"
              values={draft.education}
              options={data.options.education}
              onChange={(values) => updateMulti("education", values)}
            />
            <MultiSelectField
              label="学位要求"
              values={draft.degree}
              options={degreeOptions}
              onChange={(values) => updateMulti("degree", values)}
            />
            <MultiSelectField
              label="现有身份要求"
              values={draft.identity}
              options={[...new Set(data.options.identity.map(normalizeIdentity))]}
              onChange={(values) => updateMulti("identity", values)}
            />
            <MultiSelectField
              label="政治面貌要求"
              values={draft.political}
              options={data.options.political}
              onChange={(values) => updateMulti("political", values)}
            />
            <MultiSelectField
              label="民族要求"
              values={draft.ethnicity}
              options={data.options.ethnicity}
              onChange={(values) => updateMulti("ethnicity", values)}
            />
            <MultiSelectField
              label="年龄要求"
              values={draft.age}
              options={data.options.age}
              onChange={(values) => updateMulti("age", values)}
            />
            <label className="field keyword-field">
              <span>本人专业关键词</span>
              <input
                value={draft.majors}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, majors: event.target.value }))
                }
                placeholder="例如：法学、计算机、会计"
                onKeyDown={(event) => event.key === "Enter" && applyFilters()}
              />
            </label>
            <div className="filter-group-title">
              <strong>策略偏好</strong>
              <span>系统将在可报岗位池内比较这些可选择条件，寻找更有利组合</span>
            </div>
            <label className="field">
              <span>设区市（单选）</span>
              <select
                value={draft.city}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    city: event.target.value,
                    district: [],
                  }))
                }
              >
                <option value="">全部设区市</option>
                {data.options.cities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            </label>
            <MultiSelectField
              label="区县（多选）"
              values={draft.district}
              options={
                draft.city ? data.options.districtsByCity[draft.city] ?? [] : []
              }
              onChange={(values) => updateMulti("district", values)}
              disabled={!draft.city}
              emptyText={draft.city ? "全部区县" : "请先选择设区市"}
            />
            <MultiSelectField
              label="考试类别"
              values={draft.bigCategory}
              options={bigCategoryOptions}
              onChange={(values) => updateMulti("bigCategory", values)}
            />
            <MultiSelectField
              label="心理测评"
              values={draft.psychologicalTest}
              options={data.options.psychologicalTest}
              onChange={(values) => updateMulti("psychologicalTest", values)}
            />
            <MultiSelectField
              label="体能测试"
              values={draft.physicalTest}
              options={data.options.physicalTest}
              onChange={(values) => updateMulti("physicalTest", values)}
            />
            <MultiSelectField
              label="专业加试"
              values={draft.professionalTest}
              options={data.options.professionalTest}
              onChange={(values) => updateMulti("professionalTest", values)}
            />
            <label className="field">
              <span>公安岗位范围</span>
              <select
                value={draft.policeScope}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    policeScope: event.target.value as Filters["policeScope"],
                  }))
                }
              >
                <option value="all">全部岗位</option>
                <option value="only">仅公安及警察岗位</option>
                <option value="exclude">排除公安及警察岗位</option>
              </select>
            </label>
            <label className="field keyword-field">
              <span>备注关键词</span>
              <input
                value={draft.notes}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="例如：男性"
                onKeyDown={(event) => event.key === "Enter" && applyFilters()}
              />
            </label>
          </div>


        </section>

        <RegionMap key={mapQueryId} jobs={availableJobs} onDetail={setSelected} initialCity={applied.city} initialDistricts={applied.district} />

        <section className="results-section" aria-labelledby="results-title">
          <div className="results-heading">
            <div>
              <span className="panel-index">03</span>
              <div>
                <h2 id="results-title">岗位明细</h2>
                <p>
                  硬性资格可报 <strong>{eligibleJobs.length}</strong> 个，当前偏好找到{" "}
                  <strong>{filteredJobs.length}</strong> 个；可用于导出和分析{" "}
                  <strong>{availableJobs.length}</strong> 个
                  {hiddenFilteredCount > 0 && `，已隐藏 ${hiddenFilteredCount} 个`}
                </p>
              </div>
            </div>
            <div className="results-tools">
              {hiddenFilteredCount > 0 && (
                <button className="ghost-button export-button" onClick={restoreHiddenJobs}>
                  恢复隐藏
                </button>
              )}
              <button
                className="ghost-button export-button"
                onClick={exportMarkdown}
                disabled={!availableJobs.length}
              >
                导出 Markdown
              </button>
              <label className="sort-control">
                <span>排序字段</span>
                <select value={sortField} onChange={(event) => {
                  setSortField(event.target.value as SortField);
                  setPage(1);
                }}>
                  <option value="hires">招录人数</option>
                  <option value="reportRatio">报录比</option>
                  <option value="minimumWrittenScore">最低进面分</option>
                </select>
              </label>
              <label className="sort-control">
                <span>排序方式</span>
                <select value={sortOrder} onChange={(event) => {
                  setSortOrder(event.target.value as SortOrder);
                  setPage(1);
                }}>
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                  <option value="default">默认</option>
                </select>
              </label>
            </div>
          </div>

          {visibleJobs.length ? (
            <>
              <div className="job-table-wrap">
                <table className="job-table">
                  <thead>
                    <tr>
                      <th>年度 / 地区</th>
                      <th>招录单位与职位</th>
                      <th>核心要求与备注</th>
                      <th>招录</th>
                      <th>缴费</th>
                      <th>报录比</th>
                      <th>最低进面分</th>
                      <th title="最终录用人员中的最低笔试成绩；全部已收录录用人员均匹配到成绩时显示">最低录取分</th>
                      <th aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleJobs.map((job) => (
                      <tr
                        key={job.id}
                        className={hiddenJobIds.has(job.id) ? "is-hidden-job" : ""}
                      >
                        <td data-label="年度 / 地区">
                          <span className="year-pill">{job.year}</span>
                          <strong className="district-name">
                            {job.city === "省级机关"
                              ? "省级机关"
                              : `${job.city} · ${job.district}`}
                          </strong>
                          {hiddenJobIds.has(job.id) && (
                            <span className="hidden-status">已隐藏</span>
                          )}
                        </td>
                        <td data-label="招录单位与职位" className="job-title-cell">
                          <small>{job.unit}</small>
                          <button onClick={() => setSelected(job)}>{job.position}</button>
                          <span className="mono">职位代码 {job.code}</span>
                        </td>
                        <td data-label="核心要求与备注">
                          <div className="requirement-chips">
                            <span>{job.education}</span>
                            {job.identity && <span>{job.identity}</span>}
                            {job.political && job.political !== "不限" && (
                              <span>{job.political}</span>
                            )}
                          </div>
                          <p className="job-note">
                            <b>备注</b>
                            {job.notes || "无"}
                          </p>
                        </td>
                        <td data-label="招录">
                          <strong className="number-cell">{job.hires}</strong>
                          <small>人</small>
                        </td>
                        <td data-label="缴费">
                          <strong className="number-cell">{formatValue(job.paymentCount)}</strong>
                          <small>{job.paymentCount === null ? "未匹配" : "人"}</small>
                        </td>
                        <td data-label="报录比">
                          <strong className="ratio-cell">{formatRatio(job.reportRatio)}</strong>
                          <small>缴费 ÷ 招录</small>
                        </td>
                        <td data-label="最低进面分">
                          <strong className="score-cell">
                            {formatValue(job.minimumWrittenScore)}
                          </strong>
                          <small>笔试成绩</small>
                        </td>
                        <td data-label="最低录取分">
                          <strong className="score-cell">
                            {formatValue(minimumAdmittedWrittenScore(job))}
                          </strong>
                          <small>
                            {!job.admitted.length ? "无录用数据" : minimumAdmittedWrittenScore(job) === null ? "成绩不全" : "录用人员笔试"}
                          </small>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="detail-button"
                              onClick={() => setSelected(job)}
                            >
                              详情 <span>›</span>
                            </button>
                            <button
                              className="hide-job-button"
                              onClick={() => toggleHiddenJob(job.id)}
                            >
                              {hiddenJobIds.has(job.id) ? "取消隐藏" : "隐藏"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <span>
                  第 {(page - 1) * PAGE_SIZE + 1}—
                  {Math.min(page * PAGE_SIZE, filteredJobs.length)} 条，共 {filteredJobs.length} 条
                </span>
                <div>
                  <button
                    disabled={page === 1}
                    onClick={() => {
                      setPage((current) => current - 1);
                      document
                        .getElementById("results-title")
                        ?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    上一页
                  </button>
                  <span>
                    {page} / {totalPages}
                  </span>
                  <button
                    disabled={page === totalPages}
                    onClick={() => {
                      setPage((current) => current + 1);
                      document
                        .getElementById("results-title")
                        ?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="no-results">
              <div>0</div>
              <h3>没有找到符合条件的岗位</h3>
              <p>可以减少筛选条件，或更换专业、备注关键词后重新查询。</p>
              <button className="ghost-button" onClick={resetFilters}>
                清空筛选
              </button>
            </div>
          )}
        </section>

        <section
          className={`insight-section${isLocalAnalysisLoading ? " is-calculating" : ""}`}
          aria-labelledby="insight-title"
          aria-busy={isLocalAnalysisLoading}
        >
          <div className="analysis-heading">
            <div>
              <span className="panel-index">04</span>
              <div>
                <h2 id="insight-title">考情分析</h2>
                <p>程序精确计算历史难度、数据覆盖和更有利的策略组合</p>
              </div>
            </div>
            <span className="analysis-count">
              {isLocalAnalysisLoading
                ? "正在后台计算…"
                : `基于 ${analyticsEligibleJobs.length.toLocaleString("zh-CN")} 个可报岗位`}
            </span>
          </div>

          {isLocalAnalysisLoading && (
            <div className="local-analysis-loading">
              正在重新计算影响因子与条件组合，岗位查询仍可正常使用。
            </div>
          )}
          {localAnalysisError && (
            <div className="analysis-error local-analysis-error" role="alert">
              {localAnalysisError}
            </div>
          )}

          <div className="analytics-summary-grid">
            <div>
              <span>硬性资格可报</span>
              <strong>{selectionAnalytics.eligible.jobCount.toLocaleString("zh-CN")}</strong>
              <small>当前偏好剩余 {selectionAnalytics.current.jobCount} 个</small>
            </div>
            <div>
              <span>缴费报录比中位数</span>
              <strong>{selectionAnalytics.current.medianRatio ?? "—"}</strong>
              <small>缴费人数 ÷ 招录人数</small>
            </div>
            <div>
              <span>最低进面分中位数</span>
              <strong>{selectionAnalytics.current.medianScore ?? "—"}</strong>
              <small>覆盖 {formatPercent(selectionAnalytics.current.scoreCoverage)}</small>
            </div>
            <div>
              <span>历史难度指数</span>
              <strong>{selectionAnalytics.current.medianDifficulty ?? "—"}</strong>
              <small>同年度、同考试类别内比较</small>
            </div>
            <div>
              <span>高可信岗位</span>
              <strong>{selectionAnalytics.current.highConfidenceJobs}</strong>
              <small>同时具备缴费、分数、面试等数据</small>
            </div>
          </div>

          <div className="method-note">
            <strong>如何理解</strong>
            <p>
              历史难度指数为0—100，越低表示同类岗位的历史竞争和分数门槛相对越低。
              它不是上岸概率；条件影响是历史相关关系，数据缺失不会被当作低难度。
            </p>
          </div>

          <div className="insight-block">
            <div className="insight-block-heading">
              <div>
                <h3>筛选条件影响因子</h3>
                <p>每个分组都与当前可报岗位池内的其余岗位比较</p>
              </div>
              <span>按影响幅度排序</span>
            </div>
            {selectionAnalytics.factorImpacts.length ? (
              <div className="factor-table-wrap">
                <table className="factor-table">
                  <thead>
                    <tr>
                      <th>维度与分组</th>
                      <th>样本</th>
                      <th>报录比</th>
                      <th>最低进面分</th>
                      <th>难度指数</th>
                      <th>年度一致性</th>
                      <th>判断</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedFactorImpacts.map((impact) => (
                      <tr key={impact.id}>
                        <td>
                          <small>{impact.dimension}</small>
                          <strong>{impact.group}</strong>
                        </td>
                        <td>
                          <strong>{impact.groupCount}</strong>
                          <small>分数覆盖 {formatPercent(impact.scoreCoverage)}</small>
                        </td>
                        <td>
                          <strong>{impact.medianRatio ?? "—"}</strong>
                          <small>差值 {formatDelta(impact.ratioDelta)}</small>
                        </td>
                        <td>
                          <strong>{impact.medianScore ?? "—"}</strong>
                          <small>原始差值 {formatDelta(impact.scoreDelta)}</small>
                        </td>
                        <td>
                          <strong>{impact.medianDifficulty ?? "—"}</strong>
                          <small>差值 {formatDelta(impact.difficultyDelta)}</small>
                        </td>
                        <td>
                          <strong>
                            {impact.stableYears}/{impact.observedYears}
                          </strong>
                          <small>年度方向较有利</small>
                        </td>
                        <td>
                          <span className={`impact-direction confidence-${impact.confidence}`}>
                            {impact.direction}
                          </span>
                          <small>可信度 {impact.confidence}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-panel">
                当前可报岗位过少或条件已经固定，暂时无法形成可靠对照。
              </div>
            )}
          </div>

          <div className="insight-block">
            <div className="insight-block-heading">
              <div>
                <h3>更有利的策略组合</h3>
                <p>只保留具备最低样本量、相对优势和数据覆盖的组合</p>
              </div>
              <span>最多展示6组</span>
            </div>
            {selectionAnalytics.recommendations.length ? (
              <div className="recommendation-grid">
                {selectionAnalytics.recommendations.map((recommendation, index) => {
                  const canApply =
                    recommendation.applyFilters.length > 0 &&
                    recommendation.applyFilters.length === recommendation.factors.length;
                  return (
                    <article className="recommendation-card" key={recommendation.id}>
                      <div className="recommendation-rank">#{index + 1}</div>
                      <span className={`confidence-badge confidence-${recommendation.confidence}`}>
                        可信度 {recommendation.confidence}
                      </span>
                      <h4>{recommendation.label}</h4>
                      <div className="recommendation-metrics">
                        <span>
                          <b>{recommendation.jobCount}</b>个岗位
                        </span>
                        <span>
                          报录比 <b>{recommendation.medianRatio ?? "—"}</b>
                        </span>
                        <span>
                          进面分 <b>{recommendation.medianScore ?? "—"}</b>
                        </span>
                        <span>
                          难度差 <b>{formatDelta(recommendation.difficultyDelta)}</b>
                        </span>
                      </div>
                      <p>
                        分数覆盖 {formatPercent(recommendation.scoreCoverage)}；在{" "}
                        {recommendation.observedYears} 个可比较年度中有{" "}
                        {recommendation.stableYears} 个年度方向较有利。
                      </p>
                      {canApply ? (
                        <button
                          className="ghost-button"
                          onClick={() => applyRecommendation(recommendation)}
                        >
                          按此组合筛选
                        </button>
                      ) : (
                        <small className="recommendation-note">
                          备注类限制需核对本人资格后手动筛选
                        </small>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-panel">
                当前范围内没有同时满足样本量和稳定性要求的有利组合，建议放宽地区或测试偏好。
              </div>
            )}
          </div>
        </section>

        <section className="analysis-section" aria-labelledby="analysis-title">
          <div className="analysis-heading">
            <div>
              <span className="panel-index">05</span>
              <div>
                <h2 id="analysis-title">选岗分析</h2>
                <p>
                  解读程序预计算的影响因子与条件组合，不再让模型估算统计值
                </p>
              </div>
            </div>
            <span className="analysis-count">
              当前待分析 {analysisJobs.length.toLocaleString("zh-CN")} 个岗位
              {hiddenFilteredCount > 0 && ` · 隐藏 ${hiddenFilteredCount}`}
              {!considerPoliceJobs && excludedPoliceCount > 0 &&
                ` · 排除公安 ${excludedPoliceCount}`}
            </span>
          </div>

          <div className="analysis-config">
            <label className="api-key-field">
              <span>DeepSeek API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <fieldset className="police-scope">
              <legend>是否考虑公安岗位</legend>
              <div>
                <button
                  type="button"
                  className={considerPoliceJobs ? "is-active" : ""}
                  aria-pressed={considerPoliceJobs}
                  onClick={() => updatePoliceScope(true)}
                >
                  考虑
                </button>
                <button
                  type="button"
                  className={!considerPoliceJobs ? "is-active" : ""}
                  aria-pressed={!considerPoliceJobs}
                  onClick={() => updatePoliceScope(false)}
                >
                  不考虑
                </button>
              </div>
            </fieldset>
            <div className="privacy-note">
              <strong>本地临时使用</strong>
              <span>
                Key 不写入项目或浏览器存储；仅发送岗位字段与成绩分布，不发送姓名、准考证号。
              </span>
            </div>
            <button
              className="primary-button analysis-button"
              onClick={analyzeWithDeepSeek}
              disabled={isAnalyzing || isLocalAnalysisLoading}
            >
              {isAnalyzing
                ? "正在分析…"
                : isLocalAnalysisLoading
                  ? "等待本地统计…"
                  : "开始选岗分析"}
            </button>
          </div>

          {analysisJobs.length > ANALYSIS_JOB_LIMIT && (
            <p className="analysis-hint">
              为控制 API 费用和上下文长度，请先将待分析岗位筛选或隐藏至{" "}
              {ANALYSIS_JOB_LIMIT} 个以内。Markdown 导出不受此限制。
            </p>
          )}

          {analysisError && (
            <div className="analysis-error" role="alert">
              {analysisError}
            </div>
          )}

          <div
            className={`analysis-output${analysis ? " has-content" : ""}`}
            aria-live="polite"
          >
            {analysis ? (
              <>
                <div className="analysis-output-meta">
                  <strong>选岗分析结果</strong>
                  <span>
                    {analysisModel || "DeepSeek"} · 基于 {analysisJobs.length} 个岗位
                    {considerPoliceJobs ? " · 含公安岗位" : " · 不含公安岗位"}
                  </span>
                </div>
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
                </div>
              </>
            ) : (
              <div className="analysis-placeholder">
                <strong>分析结果将在这里显示</strong>
                <p>
                  分析会先生成完整影响因子表，再给出低竞争条件、筛选组合和代表性岗位。
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="data-note">
          <strong>数据说明</strong>
          <p>
            {data.meta.notice}
            “报录比”按缴费人数÷招录人数计算，“最低进面分”取该岗位进面名单中的最低笔试成绩。
          </p>
        </section>
      </div>

      <footer>
        <div>
          <strong>岗查查</strong>
          <span>{data.meta.scope}</span>
        </div>
        <div className="footer-meta">
          <p>考情查询系统 · 数据更新 {data.meta.generatedAt}</p>
          <a
            className="icp-link"
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
          >
            浙ICP备2026060895号
          </a>
        </div>
      </footer>

      {selected && (
        <DetailDrawer
          job={selected}
          metric={jobMetrics.get(selected.id)}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}
