export type SortField = "hires" | "reportRatio" | "minimumWrittenScore";
export type SortOrder = "asc" | "desc" | "default";
type SortableJob = { city: string; district: string; year: number; code: string; hires: number; reportRatio: number | null; minimumWrittenScore: number | null };

export function sortJobs<T extends SortableJob>(jobs: T[], field: SortField, order: SortOrder): T[] {
  const byRegion = (a: T, b: T) => a.city.localeCompare(b.city, "zh-CN") ||
    a.district.localeCompare(b.district, "zh-CN") || b.year - a.year || a.code.localeCompare(b.code);
  return [...jobs].sort((a, b) => {
    if (order === "default") return byRegion(a, b);
    const left = a[field];
    const right = b[field];
    const leftMissing = left === null || !Number.isFinite(left);
    const rightMissing = right === null || !Number.isFinite(right);
    if (leftMissing && rightMissing) return byRegion(a, b);
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    return (order === "asc" ? left! - right! : right! - left!) || byRegion(a, b);
  });
}