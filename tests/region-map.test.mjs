import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readPublishedIndex } from "../scripts/public-data.mjs";
import { regionIndex, locateJob, summarizeRegions, totalHires } from "../app/region-data.ts";
const read = async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url), "utf8"));
const [cities, counties, { index: { jobs } }] = await Promise.all([read("cities"), read("counties"), readPublishedIndex(fileURLToPath(new URL("../public/",import.meta.url)))]);
const index = regionIndex(cities, counties);
test("地图覆盖11市90县区且行政区代码唯一", () => {
  assert.equal(index.cityNames.size, 11); assert.equal(index.countyNames.size, 90);
  assert.equal(new Set([...cities.features, ...counties.features].map(f => String(f.properties.adcode))).size, 101);
});
test("全部市县职位数、招录人数和岗位集合与原数据精确一致", () => {
  const sum = summarizeRegions(jobs, index);
  for (const region of index.cityNames.values()) {
    const expected = jobs.filter(j => j.city === region.name);
    assert.deepEqual(sum.cities.get(region.code), expected);
    assert.equal(totalHires(sum.cities.get(region.code)), totalHires(expected));
  }
  for (const region of index.countyNames.values()) {
    const expected = jobs.filter(j => j.city === region.cityName && j.district === region.name);
    assert.deepEqual(sum.counties.get(region.code), expected);
    assert.equal(totalHires(sum.counties.get(region.code)), totalHires(expected));
  }
  assert.equal(sum.counties.get("330110").length, 143);
  assert.equal(sum.cities.get("330100").length, 2087);
  const partition = [...sum.counties.values(), ...sum.cityOnly.values(), sum.province, sum.unmatched].flat();
  assert.equal(partition.length, jobs.length);
  assert.equal(new Set(partition.map(j => j.id)).size, jobs.length);
  assert.equal(totalHires(partition), totalHires(jobs));
  assert.equal(sum.unmatched.length, 0);
});
test("筛选、隐藏后的地区统计与同一岗位集合一致", () => {
  const filtered = jobs.filter(j => j.year === 2026 && j.city === "杭州市" && j.majors.includes("计算机"));
  const visible = filtered.slice(1);
  const sum = summarizeRegions(visible, index);
  assert.deepEqual(sum.cities.get("330100"), visible);
  assert.equal([...sum.counties.values(), ...sum.cityOnly.values()].flat().length, visible.length);
  assert.equal(totalHires(sum.cities.get("330100")), totalHires(visible));
  assert.equal(summarizeRegions([], index).cities.size, 0);
});
test("未知地区不猜配，不把省市级机关按单位名称分配到县区", () => {
  const job = { ...jobs[0], city: "杭州市", district: "未知新区", unit: "余杭区某单位" };
  assert.deepEqual(locateJob(job, index), { kind: "unmatched", cityCode: "330100" });
  const sum = summarizeRegions([job], index);
  assert.equal(sum.cities.get("330100").length, 1);
  assert.equal(sum.counties.size, 0);
  assert.equal(sum.unresolvedCities.get("330100").length, 1);
  assert.equal(sum.unmatched.length, 1);
  assert.equal(locateJob({ ...job, district: "市级机关" }, index).kind, "cityOnly");
  assert.equal(locateJob({ ...job, city: "省级机关" }, index).kind, "province");
  assert.equal(locateJob({ ...job, city: "其他市", district: "余杭区" }, index).kind, "unmatched");
});
