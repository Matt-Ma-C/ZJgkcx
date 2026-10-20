import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {loadJobDetail, loadJobIndex} from "../app/data-client.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function summaryFixture(count = 6) {
  const expected = {meta:{dataVersion:"public-test-v1",stats:{jobCount:count}},options:{cities:["杭州市"]},jobs:Array.from({length:count},(_,i)=>({id:`test-${i}`,city:"杭州市",year:2026}))};
  const parts = new Map();
  const manifest = {schema:"job-index-shards-v1",meta:expected.meta,options:expected.options,jobCount:count,reconstructedSha256:hash(JSON.stringify(expected)),shards:expected.jobs.map((job,i)=>{
    const path = `/data/jobs-summary/part-${i}.json`;
    const raw = JSON.stringify({dataVersion:expected.meta.dataVersion,jobs:[job]});
    parts.set(path,raw);
    return {path,sha256:hash(raw),bytes:Buffer.byteLength(raw),jobCount:1,firstId:job.id,lastId:job.id};
  })};
  return {manifest,parts,expected};
}
const fixtureFetch = (fixture) => async (url) => url === "/data/jobs-index.json"
  ? {ok:true,json:async()=>fixture.manifest}
  : {ok:true,text:async()=>fixture.parts.get(url)};

test("摘要分片并发完成顺序不影响岗位顺序，完整元数据和筛选选项保留", async () => {
  const original = global.fetch;
  const fixture = summaryFixture();
  let active = 0;
  let maximum = 0;
  global.fetch = async (url) => {
    if (url === "/data/jobs-index.json") return {ok:true,json:async()=>fixture.manifest};
    active++;
    maximum = Math.max(maximum,active);
    await new Promise(resolve => setTimeout(resolve,url.endsWith("part-0.json")?15:1));
    active--;
    return {ok:true,text:async()=>fixture.parts.get(url)};
  };
  try {
    assert.deepEqual(await loadJobIndex(),fixture.expected);
    assert.ok(maximum > 1 && maximum <= 4);
  } finally {global.fetch=original;}
});

test("真实发布分片加载保留14200岗位、数据版本与摘要锁定哈希", async () => {
  const original = global.fetch;
  const manifest = JSON.parse(await readFile(new URL("../public/data/jobs-index.json",import.meta.url),"utf8"));
  global.fetch = async (url) => {
    if (url === "/data/jobs-index.json") return {ok:true,json:async()=>manifest};
    return {ok:true,text:async()=>readFile(new URL(`../public${url}`,import.meta.url),"utf8")};
  };
  try {
    const payload = await loadJobIndex();
    assert.equal(payload.jobs.length,14200);
    assert.equal(new Set(payload.jobs.map(job=>job.id)).size,14200);
    assert.equal(payload.meta.dataVersion,manifest.meta.dataVersion);
    assert.equal(hash(JSON.stringify(payload)),"ab1de67b06802db5b87a2d712f6e785c022b6ee1144da2971aad046a878480a0");
  } finally {global.fetch=original;}
});

test("摘要请求错误后允许重试，失败不会发布部分岗位集合", async () => {
  const original = global.fetch;
  const fixture = summaryFixture(1);
  let failed = false;
  global.fetch = async (url) => {
    if (url === "/data/jobs-index.json") return {ok:true,json:async()=>fixture.manifest};
    if (!failed) {failed=true;return {ok:false,status:503};}
    return {ok:true,text:async()=>fixture.parts.get(url)};
  };
  try {
    await assert.rejects(loadJobIndex(),/503/);
    assert.deepEqual(await loadJobIndex(),fixture.expected);
    global.fetch = async () => ({ok:false,status:404});
    await assert.rejects(loadJobIndex(),/目录读取失败（404）/);
  } finally {global.fetch=original;}
});

test("摘要拒绝损坏内容、错版本、重复岗位与改变集合顺序", async () => {
  const original = global.fetch;
  try {
    const corrupted=summaryFixture(1);
    corrupted.parts.set(corrupted.manifest.shards[0].path,corrupted.parts.values().next().value+" ");
    global.fetch=fixtureFetch(corrupted);
    await assert.rejects(loadJobIndex(),/分片完整性校验失败/);
    const wrongVersion=summaryFixture(1);
    const descriptor=wrongVersion.manifest.shards[0];
    const raw=JSON.stringify({dataVersion:"other",jobs:wrongVersion.expected.jobs});
    wrongVersion.parts.set(descriptor.path,raw);
    Object.assign(descriptor,{sha256:hash(raw),bytes:Buffer.byteLength(raw)});
    global.fetch=fixtureFetch(wrongVersion);
    await assert.rejects(loadJobIndex(),/数据版本不一致/);
    const duplicated=summaryFixture(2);
    const second=duplicated.manifest.shards[1];
    const repeated=JSON.stringify({dataVersion:duplicated.expected.meta.dataVersion,jobs:[duplicated.expected.jobs[0]]});
    duplicated.parts.set(second.path,repeated);
    Object.assign(second,{sha256:hash(repeated),bytes:Buffer.byteLength(repeated),firstId:"test-0",lastId:"test-0"});
    global.fetch=fixtureFetch(duplicated);
    await assert.rejects(loadJobIndex(),/集合完整性校验失败/);
    const reordered=summaryFixture(2);
    reordered.manifest.shards.reverse();
    global.fetch=fixtureFetch(reordered);
    await assert.rejects(loadJobIndex(),/集合完整性校验失败/);
  } finally {global.fetch=original;}
});

test("摘要禁止外部和重复分片路径，取消后不返回岗位集合", async () => {
  const original=global.fetch;
  try {
    const fixture=summaryFixture(1);
    fixture.manifest.shards[0].path="https://outside.example/summary.json";
    let calls=0;
    global.fetch=async()=>{calls++;return {ok:true,json:async()=>fixture.manifest};};
    await assert.rejects(loadJobIndex(),/分片目录无效/);
    assert.equal(calls,1);
    const repeated=summaryFixture(2);
    repeated.manifest.shards[1].path=repeated.manifest.shards[0].path;
    global.fetch=fixtureFetch(repeated);
    await assert.rejects(loadJobIndex(),/分片目录无效/);
    const preAborted=new AbortController();
    preAborted.abort();
    await assert.rejects(loadJobIndex(preAborted.signal),{name:"AbortError"});
    const current=summaryFixture(1);
    const controller=new AbortController();
    global.fetch=async(url)=>{
      if(url==="/data/jobs-index.json")return {ok:true,json:async()=>current.manifest};
      controller.abort();
      return {ok:true,text:async()=>current.parts.get(url)};
    };
    await assert.rejects(loadJobIndex(controller.signal),{name:"AbortError"});
  } finally {global.fetch=original;}
});

test("详情按需读取并复用同一分片，保留摘要字段", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {ok:true, json:async () => ({jobs:[{id:"a",interviewees:[{ticket:"anon-example",writtenScore:100}]},{id:"b",interviewees:[]}]})};
  };
  try {
    const first = await loadJobDetail({id:"a",city:"杭州市",detailShard:"/data/jobs-details/test-01.json"});
    const second = await loadJobDetail({id:"b",detailShard:"/data/jobs-details/test-01.json"});
    assert.equal(first.city,"杭州市");
    assert.equal(first.interviewees.length,1);
    assert.equal(second.interviewees.length,0);
    assert.equal(calls,1);
  } finally { global.fetch = original; }
});

test("详情必须匹配发起时的数据版本，错版和缺版本被拒绝且允许刷新后重试", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {ok:true,json:async () => ({dataVersion:calls === 1 ? "old-version" : "new-version",jobs:[{id:"v",admitted:[]}]})};
  };
  try {
    const job = {id:"v",detailShard:"/data/jobs-details/test-version.json",dataVersion:"new-version"};
    await assert.rejects(loadJobDetail(job),/数据版本不一致/);
    assert.deepEqual((await loadJobDetail(job)).admitted,[]);
    await loadJobDetail(job);
    assert.equal(calls,2,"版本匹配的缓存可复用，拒绝的缓存不会阻止重试");
    await assert.rejects(loadJobDetail({...job,dataVersion:"another-version"}),/数据版本不一致/);
    assert.equal(calls,3,"不同预期版本不能复用旧缓存");
    global.fetch = async () => ({ok:true,json:async () => ({jobs:[{id:"v"}]})});
    await assert.rejects(loadJobDetail({...job,detailShard:"/data/jobs-details/test-no-version.json"}),/数据版本不一致/);
  } finally {global.fetch=original;}
});

test("取消与非法分片不会返回详情，失败后允许重试", async () => {
  const original = global.fetch;
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadJobDetail({id:"a",detailShard:"/data/jobs-details/test-02.json"},controller.signal),{name:"AbortError"});
  await assert.rejects(loadJobDetail({id:"a",detailShard:"https://outside.example/a.json"}),/路径无效/);
  global.fetch = async () => {
    calls++;
    if (calls === 1) return {ok:false,status:503};
    return {ok:true,json:async () => ({jobs:[{id:"a",admitted:[]}]})};
  };
  try {
    await assert.rejects(loadJobDetail({id:"a",detailShard:"/data/jobs-details/test-03.json"}),/503/);
    assert.deepEqual((await loadJobDetail({id:"a",detailShard:"/data/jobs-details/test-03.json"})).admitted,[]);
    assert.equal(calls,2);
  } finally { global.fetch=original; }
});
