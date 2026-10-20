"use client";
import "./region-map.css";

import { useEffect, useId, useMemo, useState } from "react";
import { regionIndex, summarizeRegions, totalHires, type Feature, type GeoCollection, type RegionJob } from "./region-data";

const polygons = (f: Feature): number[][][][] => f.geometry.type === "Polygon" ? [f.geometry.coordinates as number[][][]] : f.geometry.coordinates as number[][][][];
const project = (p: number[]) => [p[0], -Math.log(Math.tan(Math.PI / 4 + p[1] * Math.PI / 360)) * 180 / Math.PI];
function makeProjection(features: Feature[]) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const f of features) for (const poly of polygons(f)) for (const ring of poly) for (const point of ring) {
    const [x, y] = project(point); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const scale = Math.min(690 / (right - left || 1), 570 / (bottom - top || 1));
  return (point: number[]) => { const [x, y] = project(point); return [370 + (x - (left + right) / 2) * scale, 310 + (y - (top + bottom) / 2) * scale]; };
}

export default function RegionMap<T extends RegionJob>({ jobs, onDetail, initialCity = "", initialDistricts = [], expanded: suppliedExpanded, onToggle }: { jobs: T[]; onDetail: (job: T) => void; initialCity?: string; initialDistricts?: string[]; expanded?: boolean; onToggle?: () => void }) {
  const mapId = useId();
  const titleId = `${mapId}-title`;
  const contentId = `${mapId}-content`;
  const [localExpanded, setLocalExpanded] = useState(true);
  const expanded = suppliedExpanded ?? localExpanded;
  const toggleExpanded = () => { if (suppliedExpanded === undefined) setLocalExpanded(value => !value); onToggle?.(); };
  const [geo, setGeo] = useState<{ cities: GeoCollection; counties: GeoCollection } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [level, setLevel] = useState(initialCity && initialCity !== "省级机关" ? "county" : "city");
  const [manualCity, setManualCity] = useState<string | null>(null);
  const [scopeDistricts, setScopeDistricts] = useState(initialDistricts);
  const setCity = (value: string) => { setManualCity(value); setScopeDistricts([]); };
  const [manualSelected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(["cities", "counties"].map(async (name) => {
      const response = await fetch(`/data/${name}.json`, { signal: controller.signal });
      if (!response.ok) throw new Error("地图边界加载失败");
      return await response.json() as GeoCollection;
    })).then(([cities, counties]) => { setGeo({ cities, counties }); setFailed(false); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  const index = useMemo(() => geo ? regionIndex(geo.cities, geo.counties) : null, [geo]);
  const city = manualCity ?? index?.cityNames.get(initialCity)?.code ?? "";
  const initialCounty = initialDistricts.length === 1 ? index?.countyNames.get(`${initialCity}|${initialDistricts[0]}`)?.code : undefined;
  const selected = manualSelected ?? initialCounty ?? (initialCity === "省级机关" ? "province" : city || "all");
  const summary = useMemo(() => index ? summarizeRegions(jobs, index) : null, [jobs, index]);
  const features = (() => {
    if (!geo) return [];
    if (level === "city") return geo.cities.features;
    const cityFeatures = geo.counties.features.filter(f => !city || String(f.properties.cityAdcode) === city);
    const scoped = cityFeatures.filter(f => scopeDistricts.includes(f.properties.name));
    return scopeDistricts.includes("市级机关") || !scoped.length ? cityFeatures : scoped;
  })();
  const xy = makeProjection(features);
  const pathFor = (f: Feature) => polygons(f).map(poly => poly.map(ring => ring.map((p, i) => { const [x, y] = xy(p); return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`; }).join("") + "Z").join("")).join("");
  const heading = <div className="region-heading"><div className="region-heading-copy"><span className="region-eyebrow">浙江 · 岗位分布</span><h2 id={titleId}>岗位地图</h2></div><div className="region-heading-actions"><span className="region-current-count">当前 <strong>{jobs.length.toLocaleString()}</strong> 个职位</span><button type="button" className="region-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={toggleExpanded}>{expanded ? "收起地图" : "展开地图"}</button></div></div>;
  if (!geo || !summary) return <section className={`region-panel${expanded ? "" : " region-panel-collapsed"}`} aria-labelledby={titleId}>{heading}<div id={contentId} hidden={!expanded}><p>{failed ? "地图边界加载失败，原岗位查询仍可正常使用。" : "正在载入浙江行政区地图…"}</p>{failed && <button type="button" onClick={() => { setFailed(false); setAttempt(attempt + 1); }}>重试地图</button>}</div></section>;
  const allFeatures = [...geo.cities.features, ...geo.counties.features];
  const featureByCode = (code: string) => allFeatures.find(f => String(f.properties.adcode) === code);
  const regionJobs = (code: string): T[] => {
    if (code === "all") return jobs;
    if (code === "province") return summary.province;
    if (code === "unmatched") return summary.unmatched;
    if (code.startsWith("cityOnly:")) return summary.cityOnly.get(code.slice(9)) ?? [];
    return summary.cities.get(code) ?? summary.counties.get(code) ?? [];
  };
  const regionName = (code: string) => code === "all" ? "当前筛选全部岗位" : code === "province" ? "省级机关" : code === "unmatched" ? "待匹配地区" : code.startsWith("cityOnly:") ? `${featureByCode(code.slice(9))?.properties.name} · 市级机关` : `${featureByCode(code)?.properties.cityName ?? ""}${featureByCode(code)?.properties.name ?? ""}`;
  const choose = (code: string) => { setSelected(code); setPage(1); };
  const current = regionJobs(selected);
  const pages = Math.max(1, Math.ceil(current.length / 8));
  const currentPage = Math.min(page, pages);
  const previewCode = hover ?? selected;
  const preview = regionJobs(previewCode);
  const previewFeature = featureByCode(previewCode);
  const pendingForPreview = previewFeature?.properties.cityAdcode ? (summary.unresolvedCities.get(String(previewFeature.properties.cityAdcode))?.length ?? 0) : 0;
  const maxCount = Math.max(1, ...features.map(f => regionJobs(String(f.properties.adcode)).length));
  const countyCount = [...summary.counties.values()].reduce((sum, rows) => sum + rows.length, 0);
  const cityOnlyCount = [...summary.cityOnly.values()].reduce((sum, rows) => sum + rows.length, 0);
  return <section className={`region-panel${expanded ? "" : " region-panel-collapsed"}`} aria-labelledby={titleId}>
    {heading}
    <div id={contentId} hidden={!expanded}>
    <p className="region-description">与已应用筛选及隐藏状态同步；点击区域查看岗位并打开详情。<span className="region-badge">真实岗位数据 · 2024—2026</span></p>
    <div className="region-totals"><div><strong>{jobs.length.toLocaleString()}</strong><span>当前职位数</span></div><div><strong>{totalHires(jobs).toLocaleString()}</strong><span>计划招录人数</span></div><div><strong>{countyCount.toLocaleString()}</strong><span>已定位县区职位</span></div><div><strong>{cityOnlyCount.toLocaleString()}</strong><span>市级机关职位</span></div></div>
    <div className="region-toolbar"><label>地图层级<select value={level} onChange={e => { setLevel(e.target.value); setHover(null); }}><option value="city">11市总览</option><option value="county">90县区分布</option></select></label>{level === "county" && <label>地图视野<select value={city} onChange={e => { setCity(e.target.value); setHover(null); }}><option value="">浙江全省</option>{geo.cities.features.map(f => <option key={f.properties.adcode} value={String(f.properties.adcode)}>{f.properties.name}</option>)}</select></label>}<label>查看地区<select value={selected} onChange={e => choose(e.target.value)}><option value="all">全部当前岗位</option>{features.map(f => <option key={f.properties.adcode} value={String(f.properties.adcode)}>{regionName(String(f.properties.adcode))}（{regionJobs(String(f.properties.adcode)).length}）</option>)}<option value="province">省级机关</option><option value="unmatched">待匹配</option>{!["all", "province", "unmatched"].includes(selected) && !features.some(f => String(f.properties.adcode) === selected) && <option value={selected}>{regionName(selected)}</option>}</select></label><span>查询后自动按所选市县定位；手动调整视野不改变岗位筛选。</span></div>
    <div className="region-layout"><div className="region-stage">
      <div className="region-hover" role="status" aria-live="polite"><b>{regionName(previewCode)}</b><span>{preview.length} 个职位 · 招录 {totalHires(preview)} 人</span>{pendingForPreview > 0 && <small>该市另有 {pendingForPreview} 个待定位职位，县区数并非完整总数。</small>}{preview.length === 0 && <small>{pendingForPreview ? "当前已定位记录为零，仍有待匹配记录。" : "当前筛选无匹配职位。"}</small>}</div>
      <svg className="region-svg" viewBox="0 0 740 620" aria-label="浙江行政区岗位分布图">
        {features.map(f => { const code = String(f.properties.adcode); const count = regionJobs(code).length; const incomplete = !!f.properties.cityAdcode && !!summary.unresolvedCities.get(String(f.properties.cityAdcode))?.length; return <path key={code} d={pathFor(f)} fill={count ? `hsl(213 72% ${88 - Math.sqrt(count / maxCount) * 51}%)` : incomplete ? "#cbd5e1" : "#f1f5f9"} fillRule="evenodd" className={selected === code ? "region-shape selected" : "region-shape"} role="button" tabIndex={0} aria-label={`${regionName(code)}，${count}个已匹配职位，招录${totalHires(regionJobs(code))}人${incomplete ? "，本市有待匹配记录" : ""}，查看岗位明细`} aria-pressed={selected === code} onPointerEnter={() => setHover(code)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(code)} onBlur={() => setHover(null)} onClick={() => choose(code)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(code); } }}><title>{regionName(code)}：{count} 个职位 / 招录 {totalHires(regionJobs(code))} 人</title></path>; })}
        {(level === "city" ? features : city ? features : geo.cities.features).map(f => { const center = f.properties.centroid ?? f.properties.center; if (!center) return null; const [x, y] = xy(center); return <text key={f.properties.adcode} x={x} y={y} className="region-label" textAnchor="middle">{f.properties.name}</text>; })}
      </svg>
      <div className="region-legend"><span>少</span><i/><span>多 · 按职位数着色</span><span>浅灰：当前无匹配；深灰：有待定位</span></div>
    </div><div className="region-detail" aria-label="地图地区岗位明细"><div className="region-detail-heading"><h3>{regionName(selected)}</h3><p data-testid="region-detail-count">{current.length} 个职位 · 招录 {totalHires(current)} 人</p></div>
      {summary.cities.has(selected) && <div className="region-detail-actions"><button onClick={() => { setCity(selected); setLevel("county"); setHover(null); }}>查看下属县区地图</button><button onClick={() => choose(`cityOnly:${selected}`)}>市级机关（{summary.cityOnly.get(selected)?.length ?? 0}）</button></div>}
      {current.length ? <ul className="region-jobs">{current.slice((currentPage - 1) * 8, currentPage * 8).map(job => <li key={job.id}><button onClick={() => onDetail(job)}><span>{job.year} · {job.district} · 招录 {job.hires} 人</span><strong>{job.position}</strong><small>{job.unit}</small></button></li>)}</ul> : <p>当前筛选下没有已匹配岗位。待匹配情况见下方覆盖说明。</p>}
      <div className="region-pagination"><button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一组</button><span>{currentPage} / {pages}</span><button disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一组</button></div>
    </div></div>
    <div className="region-coverage"><b>地区覆盖与独立分组</b><p>县区已定位 {countyCount} + 市级机关 {cityOnlyCount} + 省级机关 {summary.province.length} + 待匹配 {summary.unmatched.length} = 当前 {jobs.length} 个职位。市级汇总包含本市县区、市级机关和已知市的待匹配记录，不与县区数再次相加。</p><div><button onClick={() => choose("all")}>全部当前岗位</button><button onClick={() => choose("province")}>省级机关（{summary.province.length}）</button><button onClick={() => choose("unmatched")}>待匹配（{summary.unmatched.length}）</button></div><p>按岗位数据的地区归属统计，不代表实际办公地点。只使用明确的市县名称匹配行政区代码；市级机关不分摊县区。地图边界源更新于 2021 年，未核验为 2026 年最新边界。<a href="/data/map-sources.json" target="_blank" rel="noreferrer">边界来源记录</a></p></div>
    </div>
  </section>;
}
