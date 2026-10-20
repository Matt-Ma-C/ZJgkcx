"use client";

import { useId, useLayoutEffect, useRef } from "react";
import "./comparison-dialog.css";

type ComparisonJob = {
  id: string;
  year: number;
  city: string;
  district: string;
  unit: string;
  position: string;
  code?: string;
  education: string;
  degree: string;
  majors: string;
  political: string;
  identity: string;
  ethnicity?: string;
  age?: string;
  notes: string;
  psychologicalTest?: string;
  physicalTest: string;
  professionalTest: string;
  hires: number;
  paymentCount?: number | null;
  reportRatio: number | null;
  minimumWrittenScore: number | null;
  warnings?: string[];
};

function display(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "未收集或未关联" : String(value);
}

export default function ComparisonDialog<T extends ComparisonJob>({ jobs, compareIds, onCompare, onDetail, onClose }: {
  jobs: T[];
  compareIds: string[];
  onCompare: (id: string) => void;
  onDetail: (job: T) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const helpId = useId();
  const selectedIds = [...new Set(compareIds)].slice(0, 5);
  const compared = selectedIds.map(id => jobs.find(job => job.id === id)).filter((job): job is T => Boolean(job));
  const missingIds = selectedIds.filter(id => !jobs.some(job => job.id === id));

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const rows: Array<[string, (job: T) => string | number]> = [
    ["年度 / 地区", job => `${job.year} · ${job.city} · ${job.district}`],
    ["招录单位", job => display(job.unit)],
    ["职位代码", job => display(job.code)],
    ["招录人数", job => job.hires],
    ["学历 / 学位", job => `${display(job.education)} / ${display(job.degree)}`],
    ["专业要求", job => display(job.majors)],
    ["政治面貌 / 身份", job => `${display(job.political)} / ${display(job.identity)}`],
    ["民族 / 年龄", job => `${display(job.ethnicity)} / ${display(job.age)}`],
    ["心理测评", job => display(job.psychologicalTest)],
    ["体能测试 / 专业加试", job => `${display(job.physicalTest)} / ${display(job.professionalTest)}`],
    ["缴费人数", job => display(job.paymentCount)],
    ["报名竞争（缴费 / 招录）", job => job.reportRatio === null ? "未收集或未关联" : `${Number.isInteger(job.reportRatio) ? job.reportRatio : job.reportRatio.toFixed(1)} : 1`],
    ["原始最低进面分", job => display(job.minimumWrittenScore)],
    ["成绩比较状态", () => "计分口径待官方来源核验，暂不比较分数优势"],
    ["岗位备注", job => job.notes || "未提供，请核验当年公告"],
    ["数据核验提示", job => job.warnings?.length ? job.warnings.join("；") : "资格政策、专业目录与名单完整性仍需核验"],
  ];

  return (
    <dialog
      ref={dialogRef}
      className="comparison-dialog"
      aria-labelledby={titleId}
      aria-describedby={helpId}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="comparison-dialog-surface">
        <header className="comparison-dialog-header">
          <div>
            <h2 id={titleId}>对比详情 <span>已选 {compared.length} / 5 个岗位</span></h2>
            <p id={helpId}>逐项复核报考要求与历史记录。资格不明时以当年公告、目录及招录机关答复为准。</p>
          </div>
          <button ref={closeRef} type="button" className="ghost-button comparison-close" onClick={onClose} aria-label="关闭对比详情">关闭</button>
        </header>
        <div className="comparison-dialog-content">
          <p className="comparison-score-notice">原始分数未经换算，计分口径尚未确认，不能据此判断分数优势或跨口径排名。名单完整性未知，历史记录不代表完整招录结果。</p>
          {compared.length > 0 && compared.length < 3 && <p className="comparison-selection-help">当前可以查看 {compared.length} 个岗位；建议选择 3—5 个岗位，逐项核验资格与备注。</p>}
          {missingIds.length > 0 && <div className="comparison-missing" role="status"><p>有 {missingIds.length} 个已选岗位暂未载入，可先移除后重新选择。</p>{missingIds.map(id => <button type="button" className="ghost-button" key={id} onClick={() => onCompare(id)}>移除未载入岗位</button>)}</div>}
          {compared.length ? (
            <div className="comparison-grid-scroll" role="region" aria-label="岗位对比表，可横向滚动查看全部岗位" tabIndex={0}>
              <table className="comparison-grid" style={{ minWidth: `${164 + compared.length * 220}px` }}>
                <caption className="comparison-caption">岗位要求与原始历史记录对照表</caption>
                <thead>
                  <tr>
                    <th scope="col">比较项目</th>
                    {compared.map(job => <th scope="col" key={job.id}>
                      <button type="button" className="comparison-job-link" onClick={() => onDetail(job)}>{job.position}</button>
                      <span className="comparison-job-location">{job.year} · {job.city}</span>
                      <div className="comparison-job-actions">
                        <button type="button" className="text-button" onClick={() => onDetail(job)} aria-label={`查看${job.position}详情`}>查看详情</button>
                        <button type="button" className="text-button" onClick={() => onCompare(job.id)} aria-label={`将${job.position}移出对比`}>移出对比</button>
                      </div>
                    </th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, get]) => <tr key={label}><th scope="row">{label}</th>{compared.map(job => <td key={job.id}>{get(job)}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          ) : <div className="comparison-empty" role="status"><h3>还没有可对比的岗位</h3><p>关闭卡片，在岗位明细中点击“加入对比”，再打开“对比详情”。最多可选择 5 个岗位。</p><button type="button" className="primary-button" onClick={onClose}>返回岗位明细</button></div>}
        </div>
      </div>
    </dialog>
  );
}
