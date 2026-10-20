/** Conservative qualification aid. No official professional directory or policy is bundled. */
export type QualificationStatus = "met" | "unmet" | "pending";
export type QualificationMode = "requirements" | "profile";

export type Profile = {
  education: string;
  degree: string;
  major: string;
  majorEducation: string;
  political: string;
  identity: string;
  ethnicity: string;
  age: string;
  ageYear: string;
  ageDateConfirmed: boolean;
};

export const emptyProfile = (): Profile => ({
  education: "", degree: "", major: "", majorEducation: "", political: "",
  identity: "", ethnicity: "", age: "", ageYear: "", ageDateConfirmed: false,
});

export type QualificationJob = {
  year?: number;
  education: string;
  degree: string;
  majors: string;
  political: string;
  identity: string;
  ethnicity: string;
  age: string;
  notes: string;
  psychologicalTest?: string;
  physicalTest?: string;
  professionalTest?: string;
};

export type QualificationReason = {
  field: string;
  label: string;
  status: QualificationStatus;
  requirement: string;
  supplied: string;
  reason: string;
  evidence: string;
};
export type QualificationResult = { status: QualificationStatus; reasons: QualificationReason[] };
export const qualificationStatusLabel: Record<QualificationStatus, string> = {
  met: "初步满足", unmet: "不满足", pending: "待确认",
};

const clean = (value: string) => value.trim().replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")").toLowerCase();
export const isUnrestricted = (value: string) => /^(不限|无限制|无要求|专业不限|不限专业|无专业限制|政治面貌不限)$/.test(clean(value));

/** Requirement search includes explicitly unrestricted jobs; blank data is never treated as unrestricted. */
export function matchRequirementValues(
  selected: string[], requirement: string,
  options: { includeUnrestricted?: boolean; field?: string } = {},
): boolean {
  if (!selected.length) return true;
  if (options.includeUnrestricted !== false && isUnrestricted(requirement)) return true;
  const normalize = (value: string) => options.field === "identity"
    ? clean(value).replace(/^20\d{2}年应届毕业生$/, "当年应届毕业生")
    : clean(value);
  return selected.some((value) => normalize(value) === normalize(requirement));
}

// These are search hints only. Similar names are not evidence of official equivalence.
const majorAliasHints = [
  ["计算机科学与技术", "计算机科学技术", "computer science", "cs"],
  ["软件工程", "software engineering"],
  ["会计", "会计学", "accounting"],
  ["法律", "法学", "law"],
  ["机械设计制造及其自动化", "机械设计制造及自动化"],
  ["信息与计算科学", "信息与计算科学专业"],
];

function aliasCandidates(value: string): string[] {
  const normalized = clean(value);
  return majorAliasHints.find((group) => group.some((item) => clean(item) === normalized)) ?? [value];
}

/** Text search only: includes unrestricted majors and possible aliases, never certifies eligibility. */
export function matchesMajorRequirement(requirement: string, query: string): boolean {
  if (!query.trim()) return true;
  if (isUnrestricted(requirement)) return true;
  const text = clean(requirement);
  return aliasCandidates(query).some((candidate) => text.includes(clean(candidate)));
}

const educationLevels = ["高中", "专科", "本科", "硕士研究生", "博士研究生"];
function educationLevel(value: string): number {
  if (/博士/.test(value)) return 4;
  if (/硕士/.test(value)) return 3;
  if (/本科/.test(value)) return 2;
  if (/专科|大专/.test(value)) return 1;
  if (/高中|中专/.test(value)) return 0;
  return -1;
}
function degreeLevel(value: string): number {
  if (/博士/.test(value)) return 3;
  if (/硕士/.test(value)) return 2;
  if (/学士/.test(value)) return 1;
  return -1;
}

function makeReason(field: string, label: string, requirement: string, supplied: string,
  status: QualificationStatus, reason: string, evidence = "岗位要求原文与本人自填信息；未经招录机关审核"): QualificationReason {
  return { field, label, requirement, supplied, status, reason, evidence };
}

function levelReason(field: "education" | "degree", requirement: string, supplied: string): QualificationReason {
  const label = field === "education" ? "学历" : "学位";
  const add = (status: QualificationStatus, reason: string) => makeReason(field, label, requirement, supplied, status, reason);
  if (isUnrestricted(requirement)) return add("met", "岗位明确不限此项。");
  if (!requirement) return add("pending", "岗位此项未收录，不能视为不限。");
  if (!supplied) return add("pending", `尚未填写本人${label}。`);
  if (field === "degree" && supplied === "无学位") return add("unmet", "本人填写无学位，与岗位列出的学位要求不符。");
  const parse = field === "education" ? educationLevel : degreeLevel;
  const minimum = parse(requirement), own = parse(supplied);
  if (minimum < 0 || own < 0) return add("pending", "无法仅按已收录文字识别要求，请核对公告原文。");
  if (own < minimum) return add("unmet", `自填${label}低于岗位文字列出的层次。`);
  if (own === minimum) return add("met", `自填${label}与岗位列出的层次相符；仍需核对证书及专业组合。`);
  return add("pending", /及以上|以上/.test(requirement)
    ? `岗位写有“及以上”，但高${label}不能代替对所持学历、学位和专业组合的审核；请按报考年度公告确认。`
    : `自填层次高于岗位列明层次，不能推定高${label}自动符合，请咨询招录单位。`);
}

type MajorClause = { scope: string; names: string[] };
function majorClauses(requirement: string): MajorClause[] {
  let previousScope = "";
  return requirement.split(/[；;\n]+/).map((part) => {
    const clause = part.trim();
    const match = clause.match(/^(研究生|博士研究生|硕士研究生|本科|专科|高中|中专)\s*所学专业要求为[：:]\s*(.*)$/);
    // Source rows use “； 本科…”. Wrapped lists also retain the previous
    // education scope until another explicit education prefix begins.
    if (match) previousScope = match[1];
    const scope = previousScope;
    const names = (match?.[2] ?? clause).split(/[、,，]+/).map((name) => clean(name).replace(/\(\d{4,8}\)/g, "")).filter(Boolean);
    return { scope, names };
  });
}
function sameScope(scope: string, supplied: string): boolean {
  if (!scope) return true;
  if (scope === "研究生") return /硕士|博士|研究生/.test(supplied);
  return educationLevel(scope) === educationLevel(supplied) && educationLevel(scope) >= 0;
}

function majorReason(requirement: string, profile: Profile): QualificationReason {
  const add = (status: QualificationStatus, reason: string, evidence?: string) =>
    makeReason("major", "专业与学历组合", requirement, [profile.majorEducation, profile.major].filter(Boolean).join("／"), status, reason, evidence);
  if (isUnrestricted(requirement)) return add("met", "岗位原文明示专业不限；其他资格仍需逐项核验。");
  if (!requirement) return add("pending", "专业要求未收录，不能视为不限。");
  if (!profile.major.trim()) return add("pending", "尚未填写毕业证书上的专业全称。");
  const clauses = majorClauses(requirement);
  const ownName = clean(profile.major).replace(/\(\d{4,8}\)/g, "");
  const scoped = clauses.some((clause) => clause.scope);
  if (scoped && !profile.majorEducation) return add("pending", "岗位按学历层次列出专业，请填写该专业所属的学历层次。");
  if (profile.education && profile.majorEducation && educationLevel(profile.education) !== educationLevel(profile.majorEducation)) return add("pending", "拟用于报考的学历与专业所属学历不是同一层次；请核对可用于报考的完整证书组合，不能混用不同层次证书。");
  const applicable = clauses.filter((clause) => sameScope(clause.scope, profile.majorEducation));
  if (!applicable.length) return add("pending", "自填专业的学历层次未出现在专业要求中；需确认能否使用其他层次的学历与专业报考。");
  const names = applicable.flatMap((clause) => clause.names);
  if (names.includes(ownName) && !/类$/.test(ownName)) return add("met", "该学历层次的专业全称与岗位列名一致。", "岗位专业要求原文逐项列名；尚未核验当年官方目录和证书");
  const aliases = aliasCandidates(profile.major).map(clean);
  if (names.some((name) => aliases.includes(name))) return add("pending", "命中可能的专业别名或近似名称，须凭当年专业目录、代码或招录单位答复核实，不能据此认定符合。", "本地文本别名提示；非官方专业目录");
  if (names.some((name) => /类$/.test(name))) return add("pending", "岗位含专业类别；尚未核验该年度、学历层次的官方目录归属，不能仅按名称子串认定符合。", "岗位类别文字；官方目录归属未核验");
  return add("unmet", "自填专业全称未命中该学历层次列出的专业；如涉及更名或目录调整，须向招录单位复核。", "岗位专业要求的列名比对；非行政资格审核");
}

function politicalReason(requirement: string, supplied: string): QualificationReason {
  const add = (status: QualificationStatus, reason: string) => makeReason("political", "政治面貌", requirement, supplied, status, reason);
  if (isUnrestricted(requirement)) return add("met", "岗位明确政治面貌不限。");
  if (!requirement || !supplied) return add("pending", "岗位要求或本人政治面貌尚未填写完整。");
  const req = clean(requirement), own = clean(supplied);
  const partyMember = /^(中共党员|中共预备党员|中共正式党员)$/.test(own);
  if (req === "中共党员" && partyMember) return add("met", "中共党员要求包含中共预备党员；如备注另有限制，仍须复核备注。");
  if (req === "非中共党员") {
    if (partyMember) return add("unmet", "本人属于中共党员范围，与非中共党员要求不符。");
    if (["群众", "共青团员", "民主党派成员"].includes(own)) return add("met", "自填政治面貌不属于中共党员范围；备注限制另行核验。");
    return add("pending", "本人政治面貌未能安全归入非中共党员范围，请核对完整名称与备注。");
  }
  if (req === own) return add("met", "本人自填政治面貌与岗位文字一致。");
  if (req === "中共党员") return add("unmet", "本人自填政治面貌不在中共党员及预备党员范围。");
  return add("pending", "政治面貌包含关系不能从当前文字安全判定，请核对备注与公告。");
}

function identityReason(requirement: string, profile: Profile, year?: number): QualificationReason {
  const supplied = profile.identity;
  const add = (status: QualificationStatus, reason: string) => makeReason("identity", "招录身份", requirement, supplied, status, reason);
  if (isUnrestricted(requirement)) return add("met", "岗位明确招录身份不限。");
  if (!requirement || !supplied) return add("pending", "招录身份要求或本人身份尚不完整。");
  if (/应届/.test(requirement)) return add("pending", `需按${year ?? "对应"}年度公告核验毕业时间、择业期及相关身份；不能以当前身份回推历史年度。`);
  if (/基层|符合条件|优秀|退役|军/.test(requirement)) return add("pending", "基层经历、服务项目、军队或优秀干部身份含政策定义与证明材料，当前自填信息不足以认定。");
  return add("pending", clean(requirement) === clean(supplied)
    ? "自填身份与岗位文字一致，但身份有效期、政策定义与证明材料尚未核验。"
    : "自填身份未与岗位文字完全对应；复杂身份包含关系需按当年公告确认。");
}

function ethnicityReason(requirement: string, supplied: string): QualificationReason {
  const add = (status: QualificationStatus, reason: string) => makeReason("ethnicity", "民族", requirement, supplied, status, reason);
  if (isUnrestricted(requirement)) return add("met", "岗位明确民族不限。");
  if (!requirement || !supplied) return add("pending", "民族要求或本人信息不完整。");
  if (/少数民族/.test(requirement)) {
    if (supplied === "汉族") return add("unmet", "岗位要求少数民族，本人填写汉族。");
    if (/族$/.test(supplied) || supplied === "其他少数民族") return add("met", "本人自填信息属于少数民族范围；证件信息仍需核验。");
  }
  if (/畲族/.test(requirement)) return add(supplied === "畲族" ? "met" : "unmet", supplied === "畲族" ? "自填民族与岗位畲族要求一致。" : "自填民族与岗位畲族要求不符。");
  return add("pending", "民族限制无法从当前已收录文字安全判定。");
}

function ageReason(requirement: string, profile: Profile, year?: number): QualificationReason {
  const add = (status: QualificationStatus, reason: string) => makeReason("age", "年龄", requirement, profile.age, status, reason);
  if (isUnrestricted(requirement)) return add("met", "岗位明确年龄不限。");
  if (!requirement || !profile.age || !profile.ageDateConfirmed) return add("pending", "请按报考年度公告指定的年龄截止日填写周岁并确认；当前日期年龄不能直接用于历史岗位。");
  if (year && profile.ageYear !== String(year)) return add("pending", `本人确认年龄的年度为${profile.ageYear || "未填写"}，该岗位为${year}年度，不能跨年度套用年龄。`);
  if (!/^\d{1,2}$/.test(profile.age)) return add("pending", "年龄须填写整数周岁。");
  const range = requirement.match(/(\d+)至(\d+)周岁/);
  if (!range || /放宽|现任|非现任/.test(requirement)) return add("pending", "岗位含年龄放宽或干部身份等条件，需要核验当年公告与本人适用情形。");
  const age = Number(profile.age), min = Number(range[1]), max = Number(range[2]);
  return add(age >= min && age <= max ? "met" : "unmet", `按本人确认的公告截止日年龄${age}周岁，对照文字范围${min}—${max}周岁；出生日期边界仍以公告为准。`);
}

export function matchQualification(job: QualificationJob, profile: Profile): QualificationResult {
  const reasons = [
    levelReason("education", job.education, profile.education),
    levelReason("degree", job.degree, profile.degree),
    majorReason(job.majors, profile),
    politicalReason(job.political, profile.political),
    identityReason(job.identity, profile, job.year),
    ethnicityReason(job.ethnicity, profile.ethnicity),
    ageReason(job.age, profile, job.year),
  ];
  const tests = [job.physicalTest === "是" ? "体能测评" : "", job.psychologicalTest === "是" ? "心理测评" : "", job.professionalTest === "是" ? "专业测试" : ""].filter(Boolean);
  reasons.push(makeReason("special", "备注与特殊限制", [job.notes, ...tests].filter(Boolean).join("；"), "", "pending",
    job.notes.trim() || tests.length
      ? "备注或测试可能涉及性别、户籍、证书、视力、服务期等要求，尚未逐项审核，必须人工确认。"
      : "已收录备注为空也不代表没有其他限制；需核对当年招录公告、通用条件及职位附注。",
    "岗位备注、测试标记与公告通用资格；尚无完整政策核验依据"));
  const status: QualificationStatus = reasons.some((reason) => reason.status === "unmet") ? "unmet"
    : reasons.some((reason) => reason.status === "pending") ? "pending" : "met";
  return { status, reasons };
}

/** Include pending cases for review, but never silently label them as eligible. */
export function matchesProfile(job: QualificationJob, profile: Profile, includePending = true): boolean {
  const result = matchQualification(job, profile);
  return result.status === "met" || (includePending && result.status === "pending");
}

export { educationLevels };
