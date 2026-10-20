"use client";

import { useEffect, useState } from "react";

type CoverageRow = {
  year: number;
  city: string;
  jobs: number;
  payment: number;
  written: number;
  interview: number;
  admission: number;
  verifiedScoreBasis: number;
};

type CoveragePayload = {
  dataVersion?: string;
  generatedAt?: string;
  dataCutoff?: string | null;
  rows: CoverageRow[];
};

const countKeys = ["jobs", "payment", "written", "interview", "admission", "verifiedScoreBasis"] as const;

function isCoveragePayload(value: unknown): value is CoveragePayload {
  if (!value || typeof value !== "object" || !("rows" in value) || !Array.isArray(value.rows)) return false;
  return value.rows.every((row: unknown) => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    return typeof entry.year === "number" && Number.isInteger(entry.year) &&
      typeof entry.city === "string" && entry.city.length > 0 &&
      countKeys.every((key) => typeof entry[key] === "number" && Number.isInteger(entry[key]) && entry[key] >= 0);
  });
}

function formatCoverage(count: number, total: number) {
  if (!total) return `${count}/0（无岗位）`;
  if (count > total) return `${count}/${total}（待复核）`;
  return `${count}/${total}（${(count / total * 100).toFixed(1)}%）`;
}

export default function DataCoverage({ dataVersion }: { dataVersion?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<CoveragePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!expanded || data) return;
    const controller = new AbortController();
    let active = true;
    fetch("/data/data-coverage.json", { signal: controller.signal, cache: "no-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`覆盖记录加载失败（${response.status}）`);
        const payload: unknown = await response.json();
        if (!isCoveragePayload(payload)) throw new Error("覆盖记录格式不正确，请核验本地数据版本");
        if (dataVersion && payload.dataVersion !== dataVersion) throw new Error("覆盖记录与当前岗位摘要版本不同，请刷新页面后重试");
        if (active) setData(payload);
      })
      .catch((reason: unknown) => {
        if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "覆盖记录加载失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [expanded, data, attempt, dataVersion]);

  return (
    <details className="source-details" onToggle={(event) => {
      const open = event.currentTarget.open;
      setExpanded(open);
      setLoading(open && !data);
      if (open) setError("");
    }}>
      <summary>查看年度与城市资料收录覆盖</summary>
      <p className="workspace-help">覆盖率只说明本库收录情况，不能代表当地真实成绩水平，也不能据此认定官方未公布。</p>
      {expanded && loading && <p className="workspace-help" role="status">正在加载覆盖记录；收起此处可取消加载。</p>}
      {expanded && error && <p className="workspace-help" role="alert">{error}。<button type="button" onClick={() => {
        setLoading(true);
        setError("");
        setAttempt((value) => value + 1);
      }}>重试</button></p>}
      {expanded && data && <>
        <p className="workspace-help">
          原始汇总生成日期：{typeof data.generatedAt === "string" ? data.generatedAt : "未记录"}；
          实际数据截止时间：{typeof data.dataCutoff === "string" && data.dataCutoff ? data.dataCutoff : "尚未由官方来源核实"}。
          生成日期不等于官方发布时间或资料完整截止时间。
        </p>
        <div className="table-scroll">
          <table className="people-table">
            <caption>各环节已收录岗位数 / 该年度该城市岗位总数</caption>
            <thead><tr>
              <th scope="col">年度</th><th scope="col">城市</th><th scope="col">岗位总数</th>
              <th scope="col">缴费数据</th><th scope="col">笔试原值</th><th scope="col">进面记录</th>
              <th scope="col">录用记录</th><th scope="col">已核实计分口径</th>
            </tr></thead>
            <tbody>{data.rows.map((row) => <tr key={`${row.year}-${row.city}`}>
              <td>{row.year}</td><th scope="row">{row.city}</th><td>{row.jobs}</td>
              <td>{formatCoverage(row.payment, row.jobs)}</td><td>{formatCoverage(row.written, row.jobs)}</td>
              <td>{formatCoverage(row.interview, row.jobs)}</td><td>{formatCoverage(row.admission, row.jobs)}</td>
              <td>{formatCoverage(row.verifiedScoreBasis, row.jobs)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!data.rows.length && <p className="workspace-help">当前版本尚无覆盖统计记录。</p>}
      </>}
      <p className="workspace-help">
        状态释义：未公布＝已有官方来源明确确认尚未公布；未收集＝本库尚未收录，不能推断官方是否公布；
        关联失败＝已有来源或记录，但尚未成功关联到岗位或成绩；待复核＝存在异常线索或计分依据尚需核验。
        本次没有根据缺失数据标记“官方未公布”。录用记录覆盖不代表名单完整，笔试原值覆盖不代表计分口径已可比。
      </p>
    </details>
  );
}
