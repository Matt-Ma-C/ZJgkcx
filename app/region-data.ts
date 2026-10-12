export type Feature = {
  properties: { adcode: number | string; name: string; cityName?: string; cityAdcode?: number | string; center?: number[]; centroid?: number[] };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
};
export type GeoCollection = { features: Feature[] };
export type RegionJob = { id: string; city: string; district: string; hires: number; year: number; unit: string; position: string };
export type Region = { code: string; name: string; cityCode?: string; cityName?: string };
export function regionIndex(cities: GeoCollection, counties: GeoCollection) {
  const cityNames = new Map(cities.features.map(({ properties: p }) => [p.name, { code: String(p.adcode), name: p.name }]));
  const countyNames = new Map(counties.features.map(({ properties: p }) => [`${p.cityName}|${p.name}`, { code: String(p.adcode), name: p.name, cityCode: String(p.cityAdcode), cityName: p.cityName }]));
  return { cityNames, countyNames };
}
export function locateJob(job: RegionJob, index: ReturnType<typeof regionIndex>) {
  if (job.city === "省级机关") return { kind: "province" as const };
  const city = index.cityNames.get(job.city);
  if (!city) return { kind: "unmatched" as const };
  // Only an exact city + district match is accepted. Unit names and job codes
  // are not geographic identifiers; never infer a workplace from them.
  const county = index.countyNames.get(`${job.city}|${job.district}`);
  if (county) return { kind: "county" as const, cityCode: city.code, countyCode: county.code };
  if (job.district === "市级机关") return { kind: "cityOnly" as const, cityCode: city.code };
  return { kind: "unmatched" as const, cityCode: city.code };
}
export function summarizeRegions<T extends RegionJob>(jobs: T[], index: ReturnType<typeof regionIndex>) {
  const cities = new Map<string, T[]>();
  const counties = new Map<string, T[]>();
  const cityOnly = new Map<string, T[]>();
  const unresolvedCities = new Map<string, T[]>();
  const province: T[] = [], unmatched: T[] = [];
  const push = (map: Map<string, T[]>, key: string, job: T) => { const group = map.get(key) ?? []; group.push(job); map.set(key, group); };
  for (const job of jobs) {
    const location = locateJob(job, index);
    if (location.cityCode) push(cities, location.cityCode, job);
    if (location.kind === "county") push(counties, location.countyCode, job);
    else if (location.kind === "cityOnly") push(cityOnly, location.cityCode, job);
    else if (location.kind === "province") province.push(job);
    else { unmatched.push(job); if (location.cityCode) push(unresolvedCities, location.cityCode, job); }
  }
  return { cities, counties, cityOnly, unresolvedCities, province, unmatched };
}
export const totalHires = (jobs: RegionJob[]) => jobs.reduce((sum, job) => sum + job.hires, 0);
