import type { RecommendationFilter } from "./analytics";

export type MultiFilterKey = "year" | "city" | "district" | "education" | "degree" | "identity" | "political" | "ethnicity" | "age" | "bigCategory" | "psychologicalTest" | "physicalTest" | "professionalTest";
export type Filters = Record<MultiFilterKey, string[]> & { majors: string; notes: string; policeScope: "all" | "only" | "exclude" };
export const filterLabels: Record<keyof Filters, string> = { year: "年度", city: "设区市", district: "区县", education: "学历", degree: "学位", identity: "身份", political: "政治面貌", ethnicity: "民族", age: "年龄", bigCategory: "考试类别", psychologicalTest: "心理测评", physicalTest: "体能测试", professionalTest: "专业加试", majors: "专业关键词", notes: "备注关键词", policeScope: "公安范围" };
export const preferenceKeys = ["city", "district", "bigCategory", "psychologicalTest", "physicalTest", "professionalTest", "notes", "policeScope"] as const;
export const createEmptyFilters = (): Filters => ({ year: [], city: [], district: [], education: [], degree: [], identity: [], political: [], ethnicity: [], age: [], bigCategory: [], psychologicalTest: [], physicalTest: [], professionalTest: [], majors: "", notes: "", policeScope: "all" });
export const filterIsActive = (key: keyof Filters, value: Filters[keyof Filters]) => Array.isArray(value) ? value.length > 0 : key === "policeScope" ? value !== "all" : Boolean(value.trim());
export function appliedTags(filters: Filters) {
  return (Object.keys(filterLabels) as (keyof Filters)[]).filter(key => filterIsActive(key, filters[key])).map(key => ({ key, label: filterLabels[key], value: Array.isArray(filters[key]) ? (filters[key] as string[]).join("、") : String(filters[key]) }));
}
export function recommendationPreview(filters: Filters, proposed: RecommendationFilter[], locked: string[]) {
  const next = structuredClone(filters);
  const changes: string[] = [];
  const preserved: string[] = [];
  for (const { key, value } of proposed) {
    const old = filters[key];
    if (locked.includes(key) && filterIsActive(key, old)) {
      preserved.push(`${filterLabels[key]}：${Array.isArray(old) ? old.join("、") : old}（必须满足，已保留）`);
      continue;
    }
    if (key === "city" && filters.district.length) {
      preserved.push("地区：已设置区县，保留原地区范围；请手动核验跨市变更");
      continue;
    }
    if (key === "policeScope") next.policeScope = value as Filters["policeScope"];
    else next[key] = [value];
    if (JSON.stringify(old) !== JSON.stringify(next[key])) changes.push(`${filterLabels[key]}：${Array.isArray(old) ? old.join("、") || "全部" : old || "全部"} → ${value}`);
  }
  return { next, changes, preserved };
}

export type CandidateRecord = { favorite: boolean; note: string; reason: string };
export type SavedScheme = { id: string; name: string; filters: Filters; locked: string[] };
export type WorkspaceState = { version: 1; schemes: SavedScheme[]; candidates: Record<string, CandidateRecord>; hidden: string[]; view: "list" | "map" };
export const STORAGE_KEY = "gangchacha.workspace.v1";
export const emptyWorkspace = (): WorkspaceState => ({ version: 1, schemes: [], candidates: {}, hidden: [], view: "list" });
export function readWorkspace(raw: string | null): WorkspaceState {
  const empty = emptyWorkspace();
  if (!raw || raw.length > 3_000_000) return empty;
  try {
    const input = JSON.parse(raw);
    if (!input || input.version !== 1) return empty;
    const candidates: Record<string, CandidateRecord> = {};
    for (const [id, record] of Object.entries(input.candidates ?? {}).slice(0, 15000)) {
      if (!record || typeof record !== "object" || id === "__proto__") continue;
      const value = record as CandidateRecord;
      candidates[id] = { favorite: value.favorite === true, note: typeof value.note === "string" ? value.note.slice(0, 4000) : "", reason: typeof value.reason === "string" ? value.reason.slice(0, 1000) : "" };
    }
    const schemes: SavedScheme[] = [];
    for (const item of (Array.isArray(input.schemes) ? input.schemes : []).slice(0, 30)) {
      if (!item || typeof item.name !== "string" || typeof item.id !== "string" || !item.filters) continue;
      const filters = createEmptyFilters();
      for (const key of Object.keys(filters) as (keyof Filters)[]) {
        const value = item.filters[key];
        if (Array.isArray(filters[key]) && Array.isArray(value) && value.every(v => typeof v === "string")) (filters[key] as string[]) = value.slice(0, 100);
        else if (key === "policeScope" && ["all", "only", "exclude"].includes(value)) filters.policeScope = value;
        else if ((key === "majors" || key === "notes") && typeof value === "string") filters[key] = value.slice(0, 512);
      }
      schemes.push({ id: item.id.slice(0, 100), name: item.name.slice(0, 80), filters, locked: Array.isArray(item.locked) ? item.locked.filter((key: string) => preferenceKeys.includes(key as typeof preferenceKeys[number])) : [...preferenceKeys] });
    }
    return { version: 1, schemes, candidates, hidden: Array.isArray(input.hidden) ? input.hidden.filter((v: unknown) => typeof v === "string").slice(0, 15000) : [], view: input.view === "map" ? "map" : "list" };
  } catch { return empty; }
}
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
export function buildCsv(rows: unknown[][]) { return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n"); }
