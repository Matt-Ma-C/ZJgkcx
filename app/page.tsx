"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import SafeAnalysisMarkdown from "./safe-analysis-markdown";
import RegionMap from "./region-map";
import ComparisonDialog from "./candidate-workspace";
import "./workflow-pages.css";
import DataCoverage from "./data-coverage";
import { emptyProfile, matchQualification, matchRequirementValues, matchesMajorRequirement, qualificationStatusLabel, type Profile } from "./qualification";
import { ProfileEditor, QualificationReasons } from "./qualification-ui";
import { createEmptyFilters, filterLabels, preferenceKeys, appliedTags, recommendationPreview, emptyWorkspace, readWorkspace, STORAGE_KEY, buildCsv, type Filters, type MultiFilterKey } from "./selection-workflow";
import { createAnalysisSession, snapshotKey, type AnalysisSnapshot } from "./analysis-session";
import { loadJobDetail, loadJobIndex } from "./data-client";
import { sortJobs, type SortField, type SortOrder } from "./job-sort";
import { minimumAdmittedWrittenScore } from "./admission-score";
import {
  formatAnalyticsContext,
  type AnalyticsJob,
  type CombinationRecommendation,
  type JobMetric,
  type SelectionAnalytics,
} from "./analytics";

type NameStatus = "public" | "source-masked" | "source-missing";

type Person = {
  name: string;
  nameStatus: NameStatus;
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
  nameStatus: NameStatus;
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
  intervieweeCount?: number;
  admittedCount?: number;
  minAdmittedWrittenScore?: number | null;
  detailShard?: string;
  scoreProvenance?: AnalyticsJob["scoreProvenance"];
  scoreSummary?: { written: string; interview: string };
  dataStatus?: Record<string, string>;
  sourceRecords?: Array<{ stage: string; officialUrl: string | null; publishedAt: string | null; collectedAt: string | null; originalRow: number | null; matchingBasis: string }>;
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
    dataVersion?: string;
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

const normalizeIdentity = (value: string) => /^202[456]年应届毕业生$/.test(value) ? "当年应届毕业生" : value;

const PAGE_SIZE = 20;
const ANALYSIS_JOB_LIMIT = 15_000;
const matchMulti = (selectedValues: string[], value: string | number) => selectedValues.length === 0 || selectedValues.includes(String(value));
function effectiveFilters(filters: Filters, mode: "requirements" | "profile"): Filters {
  return mode === "requirements" ? structuredClone(filters) : { ...structuredClone(filters), education: [], degree: [], identity: [], political: [], ethnicity: [], age: [], majors: "" };
}

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
    intervieweeCount: job.intervieweeCount ?? interviewees.length,
    admittedCount: job.admittedCount ?? admitted.length,
    ...(includeScoreDistribution
      ? {
          writtenScoreSummary: job.scoreSummary?.written ?? scoreDistribution(
            interviewees.map((person) => person.writtenScore),
          ),
          interviewScoreSummary: job.scoreSummary?.interview ?? scoreDistribution(
            interviewees.map((person) => person.interviewScore),
          ),
        }
      : {}),
  };
}

function formatValue(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function personNameNotice(person: Pick<Person, "name" | "nameStatus">) {
  if (person.nameStatus === "source-masked") return "来源已脱敏";
  return /\p{Co}/u.test(person.name) ? "来源含特殊字形，待核验" : "";
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
  return active.length ? active.join("；") : "未设置岗位文本或地区条件；本人模式还应用内存中的文字初筛";
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
      `笔试：${job.scoreSummary?.written ?? scoreDistribution(job.interviewees.map((person) => person.writtenScore))}`,
      `面试：${job.scoreSummary?.interview ?? scoreDistribution(job.interviewees.map((person) => person.interviewScore))}`,
    ].join("<br>");
    const metric = metrics?.get(job.id);
    const difficulty = metric
      ? `${metric.difficultyBand}（${metric.difficultyScore ?? "—"}；证据质量${metric.confidence}）`
      : "—";
    return `| ${job.year} | ${escapeMarkdown(region)} | ${escapeMarkdown(unitAndPosition)} | ${escapeMarkdown(requirements)} | ${job.hires} | ${escapeMarkdown(job.paymentCount)} | ${escapeMarkdown(formatRatio(job.reportRatio))} | ${escapeMarkdown(job.minimumWrittenScore)} | ${escapeMarkdown(difficulty)} | ${escapeMarkdown(distribution)} |`;
  });

  return `# 浙江公务员岗位考情数据

- 导出时间：${generatedAt}
- 岗位数量：${jobs.length}
- 当前筛选：${summarizeFilters(filters)}
- 查询结果包含的资格判断仅为文字初筛；若使用本人模式，个人档案不随导出发送，待确认项须回查公告。
- 口径说明：报录比 = 缴费人数 ÷ 招录人数；成绩为已关联记录原始值，满分、科目及折算待核验，不能跨口径比较分数优势。
- 名单完整性未知；已收录录用者最低笔试成绩不等于最终录取线。
- 使用建议：可将本文提供给大模型，要求比较地区、资格限制、备注限制、报录比和进面分数，并关注样本量与数据缺失。

| 年度 | 地区 | 招录单位与职位 | 核心要求与备注 | 招录 | 缴费 | 报录比 | 最低进面分 | 同口径综合指标与证据质量 | 参加面试人员的笔试和面试成绩分布 |
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
  qualification, loading, error, onRetry,
  onClose,
}: {
  job: Job;
  qualification?: ReturnType<typeof matchQualification>;
  loading?: boolean; error?: string; onRetry: () => void;
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
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const items = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    window.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("drawer-open");
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("drawer-open");
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
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
        ref={drawerRef}
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
          <button ref={closeButtonRef} className="icon-button" onClick={onClose} aria-label="关闭岗位详情">
            ×
          </button>
        </header>

        <div className="drawer-content">
          {qualification && <QualificationReasons result={qualification} />}
          {loading && <p role="status">正在按需载入成绩与名单详情…</p>}
          {error && <p role="alert">{error}<button onClick={onRetry}>重试详情</button></p>}
          <p className="workspace-help">成绩类型、满分、科目与折算尚待官方附件确认；原始值不换算、不用于跨口径优势判断。已收录录用者最低笔试成绩不是最终录取线。姓名按来源名单展示；来源已脱敏或未提供姓名时据实标注，其他身份字段省略。名单完整性未确认。</p>
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
                          <strong>{person.name || "来源未提供姓名"}</strong>
                          {personNameNotice(person) && <small>（{personNameNotice(person)}）</small>}
                          {admittedTickets.has(person.ticket) && (
                            <span className="admitted-tag">已录用</span>
                          )}
                        </td>
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
                <h3>已收录录用记录</h3>
              </div>
              <p>共 {job.admitted.length} 人</p>
            </div>
            {job.admitted.length ? (
              <div className="admission-list">
                {job.admitted.map((person) => (
                  <article key={`${person.ticket}-${person.name}`}>
                    <div className="avatar">{person.name.slice(-1) || "?"}</div>
                    <div>
                      <div className="admission-name">
                        <strong>{person.name || "来源未提供姓名"}</strong>
                        {personNameNotice(person) && <small>（{personNameNotice(person)}）</small>}
                        <span>拟录用</span>
                      </div>
                      <small>已省略其他身份字段；请回查官方公示核验</small>
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
              <p><strong>来源核验状态：</strong>下列为历史相对附件路径。官方链接、发布日期、采集日期、原表行号和实际关联过程未核验时明确保留为空。数据实际截止时间尚未确认。</p>
              {job.sourceRecords?.slice(0, 12).map((source, index) => <p key={`${source.stage}-${index}`}>环节 {source.stage}；官方链接：{source.officialUrl || "待补证"}；发布日期：{source.publishedAt || "待确认"}；采集日期：{source.collectedAt || "未记录"}；原表行：{source.originalRow ?? "待回查"}；匹配依据：{source.matchingBasis}</p>)}
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
  const [activePage, setActivePage] = useState<"conditions" | "jobs" | "analysis">("conditions");
  const [mapExpanded, setMapExpanded] = useState({ conditions: true, jobs: true });
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const navigateTo = useCallback((next: "conditions" | "jobs" | "analysis", target?: string) => {
    const hash = `#${next}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    setActivePage(next);
    setComparisonOpen(false);
    requestAnimationFrame(() => {
      const heading = document.getElementById(target ?? (next === "conditions" ? "filter-title" : next === "jobs" ? "results-title" : "insight-title"));
      heading?.focus({ preventScroll: true });
      (target ? heading : document.getElementById("query-pages"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);
  useEffect(() => {
    const restorePage = () => {
      const hash = window.location.hash;
      const next = ["#jobs", "#results-title"].includes(hash) ? "jobs" : ["#analysis", "#insight-title", "#analysis-title"].includes(hash) ? "analysis" : "conditions";
      setActivePage(next);
      setComparisonOpen(false);
    };
    queueMicrotask(restorePage);
    window.addEventListener("popstate", restorePage);
    window.addEventListener("hashchange", restorePage);
    return () => { window.removeEventListener("popstate", restorePage); window.removeEventListener("hashchange", restorePage); };
  }, []);
  const [mode, setMode] = useState<"requirements" | "profile">("requirements");
  const [appliedMode, setAppliedMode] = useState<"requirements" | "profile">("requirements");
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [appliedProfile, setAppliedProfile] = useState<Profile>(emptyProfile);
  const [profileRevision, setProfileRevision] = useState(0);
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [schemeName, setSchemeName] = useState("");
  const [locked, setLocked] = useState<string[]>([...preferenceKeys]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [workflowNotice, setWorkflowNotice] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof recommendationPreview> | null>(null);
  const [undoFilters, setUndoFilters] = useState<Filters | null>(null);
  const analysisSession = useRef(createAnalysisSession());
  const [analysisSnapshot, setAnalysisSnapshot] = useState<AnalysisSnapshot | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
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
  const analyticsScopeRef = useRef("");
  const [completedAnalyticsScope, setCompletedAnalyticsScope] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    loadJobIndex<Payload>(controller.signal)
      .then(setData)
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoadError(error.message);
      });
    return () => controller.abort();
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
      setCompletedAnalyticsScope(analyticsScopeRef.current);
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
      jobs: data.jobs.map(job => toAnalyticsJob(job)),
    });
    return () => {
      worker.terminate();
      analyticsWorkerRef.current = null;
    };
  }, [data]);

  useEffect(() => {
    let mounted = true;
    const session = analysisSession.current;
    queueMicrotask(() => {
      if (!mounted) return;
      try {
        const saved = readWorkspace(localStorage.getItem(STORAGE_KEY));
        setWorkspace(saved); setHiddenJobIds(new Set(saved.hidden));
      } catch { setStorageError("浏览器本地存储不可用；本次操作可继续，关闭后不会保留。"); }
      setStorageReady(true);
    });
    return () => { mounted = false; session.cancel(); };
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...workspace, hidden: [...hiddenJobIds] })); }
    catch { queueMicrotask(() => setStorageError("保存失败：浏览器存储已满或不可用，请导出查询结果。")); }
  }, [workspace, hiddenJobIds, storageReady]);
  const closeDetail = useCallback(() => { detailRequest.current += 1; setSelected(null); setDetailLoading(false); }, []);
  const toggleCompare = (id: string) => {
    setCompareIds(current => {
      if (current.includes(id)) return current.filter(value => value !== id);
      if (current.length >= 5) { setWorkflowNotice("最多并列对比 5 个岗位，请先移出一个。"); return current; }
      return [...current, id];
    });
  };
  const openDetail = async (job: Job) => {
    const requestId = ++detailRequest.current;
    setSelected(job); setDetailError("");
    if (!job.detailShard) { setDetailLoading(false); return; }
    setDetailLoading(true);
    try {
      const detail = await loadJobDetail({ ...job, dataVersion: data?.meta.dataVersion });
      if (detailRequest.current === requestId) setSelected({ ...job, ...detail });
    } catch (error) { if (detailRequest.current === requestId) setDetailError(error instanceof Error ? error.message : "详情加载失败"); }
    finally { if (detailRequest.current === requestId) setDetailLoading(false); }
  };
  const updateMulti = (key: MultiFilterKey, values: string[]) => {
    setDraft((current) => ({ ...current, [key]: values }));
  };

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

  const matchesQualifications = useCallback((job: Job, filters: Filters) => {
    if (!matchMulti(filters.year, job.year)) return false;
    if (appliedMode === "profile") return matchQualification(job, appliedProfile).status !== "unmet";
    return matchRequirementValues(filters.education, job.education) && matchRequirementValues(filters.degree, job.degree) &&
      matchRequirementValues(filters.identity, normalizeIdentity(job.identity)) && matchRequirementValues(filters.political, job.political) &&
      matchRequirementValues(filters.ethnicity, job.ethnicity) && matchRequirementValues(filters.age, job.age) && matchesMajorRequirement(job.majors, filters.majors);
  }, [appliedMode, appliedProfile]);
  const matchesPreferences = useCallback((job: Job, filters: Filters, onlyLocked = false) => {
    const check = (key: typeof preferenceKeys[number], result: boolean) => onlyLocked && !locked.includes(key) ? true : result;
    return check("city", matchMulti(filters.city, job.city)) && check("district", matchMulti(filters.district, job.district)) &&
      check("bigCategory", matchMulti(filters.bigCategory, job.bigCategory || job.jobProperty)) &&
      check("psychologicalTest", matchMulti(filters.psychologicalTest, job.psychologicalTest)) &&
      check("physicalTest", matchMulti(filters.physicalTest, job.physicalTest)) && check("professionalTest", matchMulti(filters.professionalTest, job.professionalTest)) &&
      check("notes", !filters.notes.trim() || job.notes.toLowerCase().includes(filters.notes.trim().toLowerCase())) &&
      check("policeScope", filters.policeScope === "all" || (filters.policeScope === "only" ? isPoliceJob(job) : !isPoliceJob(job)));
  }, [locked]);
  const eligibleJobs = useMemo(() => data ? data.jobs.filter(job => matchesQualifications(job, applied) && matchesPreferences(job, applied, true)) : [], [applied, data, matchesQualifications, matchesPreferences]);
  const filteredJobs = useMemo(() => sortJobs(eligibleJobs.filter(job => matchesPreferences(job, applied)), sortField, sortOrder), [applied, eligibleJobs, sortField, sortOrder, matchesPreferences]);
  const qualificationExclusions = useMemo(() => {
    if (!data || appliedMode !== "profile") return [];
    return data.jobs.filter(job => matchMulti(applied.year, job.year) && matchesPreferences(job, applied) && matchQualification(job, appliedProfile).status === "unmet");
  }, [data, applied, appliedMode, appliedProfile, matchesPreferences]);

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
  const analyticsScope = useMemo(() => JSON.stringify([analyticsEligibleJobs.map(job => job.id).sort(), analysisJobs.map(job => job.id).sort()]), [analyticsEligibleJobs, analysisJobs]);
  const localStatisticsPending = isLocalAnalysisLoading || completedAnalyticsScope !== analyticsScope;
  useEffect(() => {
    const worker = analyticsWorkerRef.current;
    if (!worker) return;
    analyticsRequestId.current += 1;
    const requestId = analyticsRequestId.current;
    analyticsScopeRef.current = analyticsScope;
    worker.postMessage({
      type: "analyze",
      requestId,
      eligibleIds: analyticsEligibleJobs.map((job) => job.id),
      currentIds: analysisJobs.map((job) => job.id),
    });
  }, [analysisJobs, analyticsEligibleJobs, analyticsScope]);
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
  const totalPages = Math.max(1, Math.ceil(availableJobs.length / PAGE_SIZE));
  const visibleJobs = availableJobs.slice((Math.min(page, totalPages) - 1) * PAGE_SIZE, Math.min(page, totalPages) * PAGE_SIZE);
  const multiKeys: MultiFilterKey[] = [
    "year",
    "city",
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
    (applied.majors ? 1 : 0) +
    (applied.notes ? 1 : 0) +
    (applied.policeScope !== "all" ? 1 : 0);

  const snapshot = useMemo<AnalysisSnapshot>(() => ({
    filters: { ...applied, mode: appliedMode, profileRevision, considerPoliceJobs, locked },
    jobIds: analysisJobs.map(job => job.id).sort(), dataVersion: data?.meta.dataVersion ?? data?.meta.generatedAt ?? "unknown",
  }), [applied, appliedMode, profileRevision, considerPoliceJobs, locked, analysisJobs, data]);
  const currentSnapshot = useRef(snapshot);
  useLayoutEffect(() => {
    currentSnapshot.current = snapshot;
    analysisSession.current.cancel();
    queueMicrotask(() => {
      setIsAnalyzing(false); setAnalysis(""); setAnalysisModel(""); setAnalysisSnapshot(null); setAnalysisError("");
      setPreview(null);
    });
  }, [snapshot]);
  const draftChanged = JSON.stringify(draft) !== JSON.stringify(applied) || mode !== appliedMode || (mode === "profile" && JSON.stringify(profile) !== JSON.stringify(appliedProfile));
  const saveScheme = () => {
    const name = schemeName.trim();
    if (!name) { setWorkflowNotice("请填写方案名称后保存。"); return; }
    setWorkspace(current => ({ ...current, schemes: [...current.schemes.filter(item => item.name !== name), { id: String(Date.now()), name, filters: effectiveFilters(applied, appliedMode), locked: [...locked] }].slice(-30) }));
    setSchemeName(""); setWorkflowNotice("已保存已应用的非敏感检索条件与底线。本人档案不保存，恢复后如需匹配请重新填写并查询。");
  };
  const emptyDiagnostics = useMemo(() => {
    if (!data || availableJobs.length) return [];
    return appliedTags(applied).map(tag => {
      const trial = { ...applied, [tag.key]: createEmptyFilters()[tag.key] };
      const count = data.jobs.filter(job => !hiddenJobIds.has(job.id) && matchesQualifications(job, trial) && matchesPreferences(job, trial)).length;
      return { ...tag, count };
    }).filter(item => item.count > 0).sort((a,b) => b.count - a.count).slice(0, 5);
  }, [availableJobs.length, data, applied, hiddenJobIds, matchesQualifications, matchesPreferences]);
  const applyFilters = () => {
    setUndoFilters(null);
    setMapQueryId((id) => id + 1);
    const next = effectiveFilters(draft, mode);
    setDraft(next); setApplied(next);
    setAppliedMode(mode); setAppliedProfile({ ...profile }); setProfileRevision(value => value + 1);
    analysisSession.current.cancel(); setIsAnalyzing(false);
    navigateTo("jobs", "results-title");
    setPage(1);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const resetFilters = () => {
    setUndoFilters(null);
    const empty = createEmptyFilters();
    setDraft(empty);
    setMapQueryId((id) => id + 1);
    setApplied(createEmptyFilters());
    setPage(1);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
    navigateTo("conditions", "filter-title");
  };

  const toggleHiddenJob = (jobId: string) => {
    setUndoFilters(null);
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
    setUndoFilters(null);
    setHiddenJobIds(new Set());
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const updatePoliceScope = (value: boolean) => {
    setUndoFilters(null);
    setConsiderPoliceJobs(value);
    setAnalysis("");
    setAnalysisError("");
    setAnalysisModel("");
  };

  const applyRecommendation = (recommendation: CombinationRecommendation) => {
    setPreview(recommendationPreview(applied, recommendation.applyFilters, locked));
    navigateTo("conditions", "recommendation-preview-title");
  };
  const commitRecommendation = () => {
    if (!preview) return;
    setUndoFilters(structuredClone(applied)); setDraft(preview.next); setApplied(preview.next); setPage(1);
    setWorkflowNotice([...preview.changes, ...preview.preserved].join("；") || "条件保持不变"); setPreview(null);
    setMapQueryId(id => id + 1);
    navigateTo("jobs", "results-title");
  };
  const exportCsv = () => {
    const rows: unknown[][] = [["岗位ID", "年度", "市", "区县", "单位", "职位", "招录", "报录比", "原始最低进面分", "成绩口径", "已收录录用者最低笔试成绩", "名单完整性", "专业", "学历", "学位", "政治面貌", "备注", "资格初步状态", "数据版本", "当前检索条件"]];
    for (const job of availableJobs) rows.push([job.id, job.year, job.city, job.district, job.unit, job.position, job.hires, job.reportRatio, job.minimumWrittenScore, "待来源确认，不作分数优势比较", job.minAdmittedWrittenScore ?? minimumAdmittedWrittenScore(job), "未知，需核对完整公示", job.majors, job.education, job.degree, job.political, job.notes, appliedMode === "profile" ? qualificationStatusLabel[matchQualification(job, appliedProfile).status] : "岗位文本检索，未经资格审核", data?.meta.dataVersion ?? data?.meta.generatedAt, summarizeFilters(applied)]);
    const url = URL.createObjectURL(new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = "岗查查_查询岗位.csv"; link.click(); URL.revokeObjectURL(url);
  };

  const exportMarkdown = () => {
    if (!availableJobs.length) return;
    const markdown = buildJobsMarkdown(availableJobs, applied, jobMetrics);
    const blob = new Blob(["\uFEFF", markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const scope = (applied.city.join("、") || "浙江全省").replace(/[\\/:*?"<>|]/g, "");
    link.href = url;
    link.download = `浙江公务员考情_${scope}_${availableJobs.length}个岗位.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const analyzeWithDeepSeek = async () => {
    setAnalysisError("");
    if (localStatisticsPending) {
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

    const request = analysisSession.current.begin(snapshot);
    setAnalysisSnapshot(request.snapshot);
    setIsAnalyzing(true);
    setAnalysis("");
    setAnalysisModel("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        signal: request.controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshot: request.snapshot,
          apiKey: apiKey.trim(),
          jobCount: analysisJobs.length,
          jobMarkdown:
            `# 用户当前条件（本次快照）\n\n${summarizeFilters(applied)}\n数据版本：${snapshot.dataVersion}\n` +
            `资格：${appliedMode === "profile" ? "本人文字初筛含待确认，个人档案未发送，不得推定资格或放宽" : "岗位要求文本检索，未经本人资格审核"}。\n` +
            `必须满足：年度、资格及已锁定的${locked.map(key => filterLabels[key as keyof Filters]).join("、")}。\n` +
            `可以放宽（仅建议，不能自动应用）：${preferenceKeys.filter(key => !locked.includes(key)).map(key => filterLabels[key]).join("、") || "无"}。\n\n` +
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
      if (!analysisSession.current.isCurrent(request.id, currentSnapshot.current)) return;
      setAnalysis(result.analysis);
      setAnalysisModel(result.model || "");
    } catch (error) {
      if (!analysisSession.current.isCurrent(request.id, currentSnapshot.current)) return;
      setAnalysisError(
        error instanceof Error ? error.message : "分析请求失败，请稍后重试。",
      );
    } finally {
      if (analysisSession.current.isCurrent(request.id, currentSnapshot.current)) setIsAnalyzing(false);
      analysisSession.current.finish(request.id);
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
    <main className="workflow-app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#conditions" onClick={event => { event.preventDefault(); navigateTo("conditions"); }} aria-label="岗查查首页">
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

      <nav className="page-nav" id="query-pages" aria-label="查询步骤">
        <button type="button" aria-current={activePage === "conditions" ? "page" : undefined} onClick={() => navigateTo("conditions")}><span className="page-step-number">1</span><span className="page-step-copy"><strong>报考条件</strong><small>设置资格与查询范围</small></span></button>
        <button type="button" aria-current={activePage === "jobs" ? "page" : undefined} onClick={() => navigateTo("jobs")}><span className="page-step-number">2</span><span className="page-step-copy"><strong>岗位明细</strong><small>查看结果与并列对比</small></span></button>
        <button type="button" aria-current={activePage === "analysis" ? "page" : undefined} onClick={() => navigateTo("analysis")}><span className="page-step-number">3</span><span className="page-step-copy"><strong>考情与选岗分析</strong><small>统计证据与辅助分析</small></span></button>
      </nav>
      <div className="workspace">
        {activePage !== "analysis" && <RegionMap key={`${mapQueryId}-${activePage}`} jobs={availableJobs} onDetail={openDetail} initialCity={applied.city.length === 1 ? applied.city[0] : ""} initialDistricts={applied.district} expanded={mapExpanded[activePage]} onToggle={() => setMapExpanded(current => ({ ...current, [activePage]: !current[activePage] }))} />}
        {(workflowNotice || storageError) && <p className="draft-notice" role="status">{storageError || workflowNotice}</p>}
        {undoFilters && <button className="ghost-button" onClick={() => { setDraft(undoFilters); setApplied(undoFilters); setUndoFilters(null); setMapQueryId(id => id + 1); setPage(1); setWorkflowNotice("已撤销最近一次推荐变化。"); navigateTo("jobs", "results-title"); }}>撤销推荐条件变化</button>}
        {activePage !== "conditions" && draftChanged && <p className="draft-notice" role="status">有尚未应用的条件修改，本页仍展示上次查询。<button className="text-button" onClick={() => navigateTo("conditions", "filter-title")}>返回条件页继续修改</button></p>}
        <div className="workflow-page" id="conditions-page" hidden={activePage !== "conditions"} aria-labelledby="filter-title">
        <section className="filter-card" aria-labelledby="filter-title">
          <div className="filter-heading">
            <div>
              <span className="panel-index">01</span>
              <h2 id="filter-title" tabIndex={-1}>报考条件</h2>
            </div>

          </div>
          <div className="filter-description">
            <p>岗位文本检索与本人初步匹配分开使用；最终资格以当年官方审核为准</p>
            {activeFilterCount > 0 && (
              <span className="active-count">已应用 {activeFilterCount} 项</span>
            )}
          </div>
          <div className="workflow-toolbar">
            <label>检索方式<select aria-label="检索方式" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="requirements">按岗位要求检索</option><option value="profile">按本人信息匹配</option></select></label>
            <span>专业关键词检索包含“不限”项；命中关键词不等于资格可报。</span>
          </div>
          {mode === "profile" && <ProfileEditor value={profile} onChange={setProfile} />}
          {mode === "profile" && <p className="workspace-help">下方岗位字段文本检索在本人模式中停用，点击查询后将以本人信息替代；年度、地区、体测等底线仍保留。待确认岗位保留供复核。</p>}
          {draftChanged && <p className="draft-notice" role="status">有未应用修改，当前结果仍对应上次查询。点击“查询岗位”应用。</p>}
          <div className="applied-tags" aria-label="已应用条件">{appliedTags(applied).map(tag => <button key={tag.key} onClick={() => { setUndoFilters(null); const next = { ...applied, [tag.key]: createEmptyFilters()[tag.key] }; setDraft(next); setApplied(next); setPage(1); }}>{tag.label}：{tag.value} ×</button>)}</div>
          <div className="filter-grid">
            <div className="filter-group-title">
              <strong>岗位要求</strong>
              <span>以下为岗位字段文本检索；本人匹配模式仅应用年度与上方本人信息</span>
            </div>
            <MultiSelectField
              label="年度"
              values={draft.year}
              options={data.options.years}
              onChange={(values) => updateMulti("year", values)}
            />
            <fieldset className="requirement-text-fields" disabled={mode === "profile"} aria-label="岗位字段文本检索">
            <MultiSelectField
              label="学历要求（文本）"
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
              <span>岗位专业关键词（含不限）</span>
              <input
                value={draft.majors}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, majors: event.target.value }))
                }
                placeholder="例如：法学、计算机、会计"
                onKeyDown={(event) => event.key === "Enter" && applyFilters()}
              />
            </label>
            </fieldset>
            <div className="filter-group-title">
              <strong>策略偏好</strong>
              <span>所有已设置条件默认必须满足；仅明确标为“可以放宽”的项可由推荐调整</span>
            </div>
            <MultiSelectField label="设区市（跨市多选）" values={draft.city} options={data.options.cities} onChange={values => setDraft(current => ({ ...current, city: values, district: [] }))} />
            <MultiSelectField label="区县（多选）" values={draft.district} options={[...new Set(draft.city.flatMap(city => data.options.districtsByCity[city] ?? []))]} onChange={values => updateMulti("district", values)} disabled={!draft.city.length} emptyText={draft.city.length ? "全部区县" : "请先选择设区市"} />
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
          <fieldset className="condition-locks"><legend>条件底线（勾选为必须满足；未勾选为可以放宽）</legend><div className="condition-lock-actions"><button type="button" className="ghost-button" onClick={() => { setUndoFilters(null); setLocked([...preferenceKeys]); }}>全选</button><button type="button" className="ghost-button" onClick={() => { setUndoFilters(null); setLocked([]); }}>全不选</button></div>{preferenceKeys.map(key => <label key={key}><input type="checkbox" checked={locked.includes(key)} onChange={e => { setUndoFilters(null); setLocked(current => e.target.checked ? [...current, key] : current.filter(value => value !== key)); }} />{filterLabels[key]}：{locked.includes(key) ? "必须满足" : "可以放宽"}</label>)}<p>年度及资格条件始终保留；全不选只允许放宽以上策略偏好，不会放宽资格底线。</p></fieldset>
          <div className="workflow-toolbar"><label>方案名称<input aria-label="方案名称" value={schemeName} maxLength={80} onChange={e => setSchemeName(e.target.value)} placeholder="例如：杭州无体测" /></label><button className="ghost-button" onClick={saveScheme}>保存已应用方案</button><label>恢复方案<select aria-label="恢复方案" defaultValue="" onChange={e => { const saved = workspace.schemes.find(item => item.id === e.target.value); if (saved) { setUndoFilters(null); setDraft(saved.filters); setApplied(saved.filters); setLocked(saved.locked); setMode("requirements"); setAppliedMode("requirements"); setPage(1); setWorkflowNotice("已恢复岗位检索方案；本人档案仍仅在本次内存中使用。"); } e.target.value = ""; }}><option value="">选择本地方案</option>{workspace.schemes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="ghost-button" onClick={() => { setProfile(emptyProfile()); setAppliedProfile(emptyProfile()); setProfileRevision(value => value + 1); setWorkflowNotice("已清除本次本人档案。"); }}>清除本人档案</button></div>
          {preview && <div className="change-preview" role="region" aria-labelledby="recommendation-preview-title"><h3 id="recommendation-preview-title" tabIndex={-1}>应用推荐前核对变化</h3>{preview.changes.map(value => <p key={value}>{value}</p>)}{preview.preserved.map(value => <p key={value}>{value}</p>)}<button className="primary-button" onClick={commitRecommendation}>应用以上变化并查看岗位</button><button className="ghost-button" onClick={() => { setPreview(null); navigateTo("analysis", "insight-title"); }}>取消并返回分析</button></div>}
          <div className="filter-actions filter-actions-bottom"><button className="ghost-button" onClick={resetFilters}>重置条件</button><button className="primary-button" onClick={applyFilters}>查询岗位</button></div>
        </section>
        <div className="page-actions"><p>查询后进入岗位明细，地图、列表和导出使用同一组已应用条件。</p><button className="ghost-button" onClick={() => navigateTo("jobs")}>查看当前岗位结果</button></div>
        </div>
        <div className="workflow-page" id="jobs-page" hidden={activePage !== "jobs"} aria-labelledby="results-title">
        <div className="page-actions"><p>当前查询：{summarizeFilters(applied)}</p><button className="ghost-button" onClick={() => navigateTo("conditions", "filter-title")}>修改报考条件</button></div>
        {appliedMode === "profile" && qualificationExclusions.length > 0 && <details className="map-collapsed"><summary>查看资格文字初筛排除原因 · {qualificationExclusions.length} 个岗位</summary><p className="workspace-help">展示前 5 个示例辅助复核，不纳入当前查询的地图、导出或分析。存在专业更名等情况时请咨询招录机关。</p>{qualificationExclusions.slice(0, 5).map(job => <article key={job.id}><button className="text-button" onClick={() => openDetail(job)}>{job.year} · {job.city} · {job.unit} · {job.position}</button><QualificationReasons result={matchQualification(job, appliedProfile)} compact /></article>)}</details>}

        <section className="results-section" aria-labelledby="results-title">
          <div className="results-heading">
            <div>
              <span className="panel-index">03</span>
              <div>
                <h2 id="results-title" tabIndex={-1}>岗位明细</h2>
                <p>
                  {appliedMode === "profile" ? "本人文字初筛（含待确认）" : "岗位要求检索（未经资格审核）"} <strong>{eligibleJobs.length}</strong> 个，当前偏好找到{" "}
                  <strong>{filteredJobs.length}</strong> 个；列表、地图与导出采用未排除岗位{" "}
                  <strong>{availableJobs.length}</strong> 个
                  {hiddenFilteredCount > 0 && `，已隐藏 ${hiddenFilteredCount} 个`}
                </p>
              </div>
            </div>
            <div className="results-tools">
              <button type="button" className="primary-button" onClick={() => setComparisonOpen(true)} disabled={!compareIds.length}>对比详情（{compareIds.length}/5）</button>
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
              <button className="ghost-button export-button" onClick={() => exportCsv()} disabled={!availableJobs.length}>导出 CSV</button>
              <label className="sort-control">
                <span>排序字段</span>
                <select value={sortField} onChange={(event) => {
                  setSortField(event.target.value as SortField);
                  setPage(1);
                }}>
                  <option value="hires">招录人数</option>
                  <option value="reportRatio">报录比</option>
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
                      <th title="仅反映已收录录用者的笔试成绩；名单完整性未知，不是最终录取线">已收录录用者最低笔试成绩</th>
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
                          <button onClick={() => openDetail(job)}>{job.position}</button>
                          <span className="mono">职位代码 {job.code}</span>
                        </td>
                        <td data-label="核心要求与备注">
                          {appliedMode === "profile" && <QualificationReasons result={matchQualification(job, appliedProfile)} compact />}
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
                          <small>{job.paymentCount === null ? job.dataStatus?.payment === "association-failed" ? "关联失败" : "未收集" : "人"}</small>
                        </td>
                        <td data-label="报录比">
                          <strong className="ratio-cell">{formatRatio(job.reportRatio)}</strong>
                          <small>缴费 ÷ 招录</small>
                        </td>
                        <td data-label="最低进面分">
                          <strong className="score-cell">
                            {formatValue(job.minimumWrittenScore)}
                          </strong>
                          <small>原始值 · 口径待核验</small>
                        </td>
                        <td data-label="已收录录用者最低笔试成绩">
                          <strong className="score-cell">
                            {formatValue(job.minAdmittedWrittenScore ?? minimumAdmittedWrittenScore(job))}
                          </strong>
                          <small>
                            已收录 {job.admittedCount ?? job.admitted.length}/{job.hires} 人；名单完整性待核验
                          </small>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="detail-button" onClick={() => toggleCompare(job.id)}>{compareIds.includes(job.id) ? "移出对比" : "加入对比"}</button>
                            <button
                              className="detail-button"
                              onClick={() => openDetail(job)}
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
                  {Math.min(page * PAGE_SIZE, availableJobs.length)} 条，共 {availableJobs.length} 条
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
              <p>先核对关键词、待确认资格和已排除岗位。以下是单独移除某项时的参考数量，不会自动放宽底线。</p><ul>{emptyDiagnostics.map(item => <li key={item.key}>{item.label}「{item.value}」单独移除后：{item.count} 个（仅诊断）</li>)}</ul>{hiddenFilteredCount > 0 && <button className="ghost-button" onClick={restoreHiddenJobs}>恢复已排除岗位</button>}
              <button className="ghost-button" onClick={resetFilters}>
                清空筛选
              </button>
            </div>
          )}
        </section>

        <div className="page-actions"><button className="ghost-button" onClick={() => navigateTo("conditions", "filter-title")}>返回报考条件</button><p>已选择 {compareIds.length} 个对比岗位 · 当前可分析 {analysisJobs.length.toLocaleString("zh-CN")} 个岗位</p><button className="primary-button" onClick={() => navigateTo("analysis")}>前往考情与选岗分析</button></div>
        </div>
        <div className="workflow-page" id="analysis-page" hidden={activePage !== "analysis"} aria-labelledby="insight-title">
        <div className="page-actions"><button className="ghost-button" onClick={() => navigateTo("jobs", "results-title")}>返回岗位明细</button><p>分析基于当前已应用查询，调整条件后会重新计算。</p><button className="ghost-button" onClick={() => navigateTo("analysis", "analysis-title")}>跳到选岗分析</button></div>
        <section
          className={`insight-section${localStatisticsPending ? " is-calculating" : ""}`}
          aria-labelledby="insight-title"
          aria-busy={isLocalAnalysisLoading}
        >
          <div className="analysis-heading">
            <div>
              <span className="panel-index">04</span>
              <div>
                <h2 id="insight-title" tabIndex={-1}>考情分析</h2>
                <p>分别查看历史报名竞争、成绩口径与资料收录程度</p>
              </div>
            </div>
            <span className="analysis-count">
              {localStatisticsPending
                ? "正在后台计算…"
                : `基于 ${analyticsEligibleJobs.length.toLocaleString("zh-CN")} 个检索候选岗位`}
            </span>
          </div>

          {localStatisticsPending && (
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
              <span>{appliedMode === "profile" ? "本人文字初筛（含待确认）" : "岗位要求检索候选"}</span>
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
              <small>原始值覆盖 {formatPercent(selectionAnalytics.current.scoreCoverage)}；可比性另行核验</small>
            </div>
            <div>
              <span>历史难度指数</span>
              <strong>{selectionAnalytics.current.medianDifficulty ?? "—"}</strong>
              <small>仅来源核验、同口径且资料充足时计算</small>
            </div>
            <div>
              <span>资料完整程度</span>
              <strong>{formatPercent(analysisJobs.length ? analysisJobs.reduce((sum, job) => sum + (jobMetrics.get(job.id)?.completeness ?? 0), 0) / analysisJobs.length : 0)}</strong>
              <small>缴费、原始笔试、进面与录用四类收录率均值；不表示名单完整</small>
            </div>
          </div>

          <div className="method-note">
            <strong>如何理解</strong>
            <p>
              报名竞争、成绩门槛、资料完整度分别呈现。仅已确认相同年度、类别、科目、满分与折算口径且样本覆盖充足时计算综合指标。口径未知的原始分数仅供回查，不计算分数优势。证据质量和年度一致性不是预测准确率。
            </p>
          </div>

          <div className="insight-block">
            <div className="insight-block-heading">
              <div>
                <h3>筛选条件影响因子</h3>
                <p>每个分组与当前候选池其余岗位比较；仅反映历史相关</p>
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
                          <small>可比口径覆盖 {formatPercent(impact.scoreCoverage)}；对照 {impact.comparisonCount} 岗</small>
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
                            {impact.observedYears ? `${impact.stableYears}/${impact.observedYears}` : "无可比年度"}
                          </strong>
                          <small>年度方向一致（双向）</small>
                        </td>
                        <td>
                          <span className={`impact-direction confidence-${impact.confidence}`}>
                            {impact.direction}
                          </span>
                          <small>证据质量 {impact.confidence}</small>
                          <details><summary>比较依据</summary><small>{impact.explanation}</small></details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-panel">
                当前检索候选岗位过少或条件已经固定，暂时无法形成可靠对照。
              </div>
            )}
          </div>

          <div className="insight-block">
            <div className="insight-block-heading">
              <div>
                <h3>证据充分的候选组合</h3>
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
                        证据质量 {recommendation.confidence}
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
                        {recommendation.stableYears} 个年度方向一致（双向）。
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
                当前证据不足以推荐。成绩口径未核验、覆盖偏低或样本不足时不输出综合推荐；可继续人工比较报名竞争与岗位要求。
              </div>
            )}
          </div>
        </section>

        <section className="analysis-section" aria-labelledby="analysis-title">
          <div className="analysis-heading">
            <div>
              <span className="panel-index">05</span>
              <div>
                <h2 id="analysis-title" tabIndex={-1}>选岗分析</h2>
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

          <p className="workspace-help">AI 可以返回“无足够证据推荐”。结果绑定查询条件、岗位集合和数据版本；更改已应用范围会取消旧请求。未应用的草稿修改不改变本次结果。</p>
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
              <strong>API Key 与数据使用说明</strong>
              <span>
                点击分析后，API Key 将从浏览器经本站服务转发至 DeepSeek，用于调用其 API；本站不将 Key 写入项目、数据库或浏览器存储。已应用的筛选快照（含关键词）、岗位信息和统计结果会一并发送。原始个人档案不会发送；请勿在关键词等输入中填写姓名、身份证号、准考证号或其他个人信息。
              </span>
            </div>
            <button
              className="primary-button analysis-button"
              onClick={analyzeWithDeepSeek}
              disabled={isAnalyzing || localStatisticsPending}
            >
              {isAnalyzing
                ? "正在分析…"
                : localStatisticsPending
                  ? "等待本地统计…"
                  : "开始选岗分析"}
            </button>
          </div>

          {isAnalyzing && <button className="ghost-button" onClick={() => { analysisSession.current.cancel(); setIsAnalyzing(false); setAnalysisError("已取消分析，未采用旧请求结果。"); }}>取消分析</button>}
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
            {analysis && analysisSnapshot && snapshotKey(analysisSnapshot) === snapshotKey(snapshot) ? (
              <>
                <div className="analysis-output-meta">
                  <strong>选岗分析结果</strong>
                  <span>
                    {analysisModel || "DeepSeek"} · 基于 {analysisSnapshot?.jobIds.length ?? 0} 个岗位 · 数据 {analysisSnapshot?.dataVersion}
                    {considerPoliceJobs ? " · 含公安岗位" : " · 不含公安岗位"}
                  </span>
                </div>
                <p className="analysis-hint">为保护隐私，AI 结果不加载图片，生成的链接仅作为文字显示；请通过官方渠道核对来源。</p>
                <div className="markdown-body">
                  <SafeAnalysisMarkdown>{analysis}</SafeAnalysisMarkdown>
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

        <div className="page-actions"><button className="ghost-button" onClick={() => navigateTo("jobs", "results-title")}>返回岗位明细</button><button className="ghost-button" onClick={() => navigateTo("conditions", "filter-title")}>重新设置报考条件</button></div>
        </div>
        <details className="data-disclosure"><summary>数据说明与年度地区覆盖</summary><section className="data-note">
          <strong>数据说明</strong>
          <p>
            {data.meta.notice}
            “报录比”按缴费人数÷招录人数计算，“最低进面分”取已关联进面名单中的原始笔试成绩。已收录录用者最低笔试成绩不是最终录取线；录用名单完整性及实际计划变化尚需回查公示。数据截止时间未由官方来源确认；生成时间不等于官方发布时间。<a href="/data/data-coverage.json" target="_blank" rel="noreferrer">查看年度地区数据覆盖</a>
          </p>
        </section>
        <DataCoverage dataVersion={data.meta.dataVersion} />
        </details>
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

      {comparisonOpen && <ComparisonDialog jobs={data.jobs} compareIds={compareIds} onCompare={toggleCompare} onDetail={job => { setComparisonOpen(false); openDetail(job); }} onClose={() => setComparisonOpen(false)} />}
      {selected && (
        <DetailDrawer
          job={selected}
          qualification={appliedMode === "profile" ? matchQualification(selected, appliedProfile) : undefined}
          loading={detailLoading}
          error={detailError}
          onRetry={() => openDetail(selected)}
          metric={jobMetrics.get(selected.id)}
          onClose={closeDetail}
        />
      )}
    </main>
  );
}
