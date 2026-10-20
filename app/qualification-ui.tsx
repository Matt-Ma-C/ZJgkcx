"use client";

import { emptyProfile, qualificationStatusLabel, type Profile, type QualificationResult } from "./qualification";

export function ProfileEditor({ value, onChange }: { value: Profile; onChange: (value: Profile) => void }) {
  const update = (field: keyof Profile, next: string | boolean) => onChange({ ...value, [field]: next });
  const select = (field: keyof Profile, label: string, options: string[]) => (
    <label className="field" key={field}>
      <span>{label}</span>
      <select value={String(value[field])} onChange={(event) => update(field, event.target.value)}>
        <option value="">尚未填写</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
  return (
    <section className="profile-editor" aria-label="本人信息匹配">
      <p className="qualification-notice">本人信息仅保存在当前页面内存。匹配依据为已收录岗位文字与自填资料；专业目录、年度政策及特殊资格未核验时显示“待确认”。历史岗位仅供参考。</p>
      <div className="filter-grid">
        {select("education", "拟用于报考的学历", ["高中", "专科", "本科", "硕士研究生", "博士研究生"])}
        {select("degree", "该学历对应学位", ["无学位", "学士", "硕士", "博士"])}
        <label className="field"><span>毕业证书专业全称</span><input value={value.major} placeholder="如：计算机科学与技术" onChange={(event) => update("major", event.target.value)} /></label>
        {select("majorEducation", "该专业所属学历", ["高中", "专科", "本科", "硕士研究生", "博士研究生"])}
        {select("political", "本人政治面貌", ["中共党员", "中共预备党员", "共青团员", "群众", "民主党派成员"])}
        <label className="field"><span>本人招录身份说明</span><input value={value.identity} placeholder="如：2026年应届毕业生；需核验当年政策" onChange={(event) => update("identity", event.target.value)} /></label>
        {select("ethnicity", "本人民族", ["汉族", "畲族", "其他少数民族"])}
        {select("ageYear", "年龄对应公告年度", ["2024", "2025", "2026"])}
        <label className="field"><span>公告截止日周岁</span><input type="number" min="0" max="99" value={value.age} placeholder="对应报考年度截止日" onChange={(event) => update("age", event.target.value)} /></label>
      </div>
      <label className="profile-confirm"><input type="checkbox" checked={value.ageDateConfirmed} onChange={(event) => update("ageDateConfirmed", event.target.checked)} />我已按本次查看岗位年度的公告年龄截止日填写；切换年度后需重新核验。</label>
      <p className="qualification-notice">一次填写一组拟用于报考的学历、学位和专业。高学历、专业近似名称或别名不自动等于符合；允许保留待确认岗位逐项复核。</p>
      <button type="button" className="secondary-button" onClick={() => onChange(emptyProfile())}>清除本人信息</button>
    </section>
  );
}

export function QualificationReasons({ result, compact = false }: { result: QualificationResult; compact?: boolean }) {
  const counts = result.reasons.reduce((all, reason) => ({ ...all, [reason.status]: all[reason.status] + 1 }), { met: 0, unmet: 0, pending: 0 });
  return (
    <details className={`qualification-reasons status-${result.status}`} open={compact ? undefined : true}>
      <summary>资格文字初筛：{qualificationStatusLabel[result.status]} · 满足 {counts.met}／不满足 {counts.unmet}／待确认 {counts.pending}</summary>
      <p className="qualification-notice">这是逐项辅助复核，最终报考资格以当年公告及招录机关审核为准。</p>
      <ul>
        {result.reasons.map((item) => (
          <li key={item.field} className={`status-${item.status}`}>
            <strong>{item.label} · {qualificationStatusLabel[item.status]}</strong>
            <p>岗位：{item.requirement || "未收录"}；本人：{item.supplied || "未填／需人工核验"}</p>
            <p>{item.reason}</p>
            <small>依据：{item.evidence}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
