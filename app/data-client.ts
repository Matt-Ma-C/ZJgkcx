/** Static summaries load first; only an opened job loads its score and published-name detail shard. */
type IndexJob = { id: string; [key: string]: unknown };
type IndexPayload = { meta: { dataVersion?: string; stats: { jobCount: number } }; options: unknown; jobs: IndexJob[] };
type IndexShard = { path: string; sha256: string; bytes: number; jobCount: number; firstId: string; lastId: string };
type IndexManifest = Omit<IndexPayload, "jobs"> & {
  schema: "job-index-shards-v1";
  jobCount: number;
  reconstructedSha256: string;
  shards: IndexShard[];
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reconstruct the complete, ordered dataset before filters, maps, CSV or analytics see it. */
export async function loadJobIndex<T = IndexPayload>(signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  const response = await fetch("/data/jobs-index.json", { cache: "no-cache", signal });
  if (!response.ok) throw new Error(`岗位摘要目录读取失败（${response.status}），请重试`);
  const manifest = await response.json() as IndexManifest;
  if (manifest?.schema !== "job-index-shards-v1" || !manifest.meta?.dataVersion || !manifest.options ||
      !Number.isSafeInteger(manifest.jobCount) || manifest.jobCount < 1 ||
      manifest.meta.stats?.jobCount !== manifest.jobCount || !/^[a-f0-9]{64}$/.test(manifest.reconstructedSha256) ||
      !Array.isArray(manifest.shards) || manifest.shards.length < 1 || manifest.shards.length > 100) {
    throw new Error("岗位摘要目录格式不正确，请刷新后重试");
  }
  const paths = new Set<string>();
  for (const shard of manifest.shards) {
    if (!/^\/data\/jobs-summary\/[\w-]+\.json$/.test(shard?.path) || paths.has(shard.path) ||
        !/^[a-f0-9]{64}$/.test(shard.sha256) || !Number.isSafeInteger(shard.bytes) || shard.bytes < 1 || shard.bytes > 25 * 1024 * 1024 ||
        !Number.isSafeInteger(shard.jobCount) || shard.jobCount < 1 || typeof shard.firstId !== "string" || typeof shard.lastId !== "string") {
      throw new Error("岗位摘要分片目录无效，请刷新后重试");
    }
    paths.add(shard.path);
  }
  // Limit simultaneous requests while preserving the manifest's original job order.
  const chunks: IndexJob[][] = new Array(manifest.shards.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, manifest.shards.length) }, async () => {
    while (next < manifest.shards.length) {
      const index = next++;
      const descriptor = manifest.shards[index];
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      const part = await fetch(descriptor.path, { cache: "no-cache", signal });
      if (!part.ok) throw new Error(`岗位摘要分片读取失败（${part.status}），请重试`);
      const raw = await part.text();
      if (new TextEncoder().encode(raw).byteLength !== descriptor.bytes || await sha256(raw) !== descriptor.sha256) {
        throw new Error("岗位摘要分片完整性校验失败，请刷新后重试");
      }
      const payload = JSON.parse(raw) as { dataVersion?: unknown; jobs?: IndexJob[] };
      if (payload.dataVersion !== manifest.meta.dataVersion) throw new Error("岗位摘要分片数据版本不一致，请刷新后重试");
      if (!Array.isArray(payload.jobs) || payload.jobs.length !== descriptor.jobCount ||
          payload.jobs[0]?.id !== descriptor.firstId || payload.jobs.at(-1)?.id !== descriptor.lastId ||
          payload.jobs.some((job) => !job || typeof job.id !== "string")) {
        throw new Error("岗位摘要分片格式不正确，请刷新后重试");
      }
      chunks[index] = payload.jobs;
    }
  }));
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  const jobs = chunks.flat();
  const payload = { meta: manifest.meta, options: manifest.options, jobs };
  if (jobs.length !== manifest.jobCount || new Set(jobs.map((job) => job.id)).size !== jobs.length ||
      await sha256(JSON.stringify(payload)) !== manifest.reconstructedSha256) {
    throw new Error("岗位摘要集合完整性校验失败，请刷新后重试");
  }
  return payload as T;
}

type DetailShard = { dataVersion?: unknown; jobs: Map<string, Record<string, unknown>> };
const detailCache = new Map<string, Promise<DetailShard>>();

export type ScoreSummary = {
  written: string;
  interview: string;
  writtenCount: number;
  interviewCount: number;
  rawMinimum: number | null;
  rawMaximum: number | null;
  note?: string;
};

export async function loadJobDetail<T extends { id: string; detailShard?: string; dataVersion?: string }>(
  job: T,
  signal?: AbortSignal,
): Promise<T> {
  if (!job.detailShard) return job;
  if (!/^\/data\/jobs-details\/[\w-]+\.json$/.test(job.detailShard)) throw new Error("岗位详情分片路径无效");
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  const cacheKey = `${job.detailShard}|${job.dataVersion ?? ""}`;
  let request = detailCache.get(cacheKey);
  if (!request) {
    request = fetch(job.detailShard, { cache: "no-cache" }).then(async (response) => {
      if (!response.ok) throw new Error(`岗位详情加载失败（${response.status}），请重试`);
      const payload = await response.json() as { dataVersion?: unknown; jobs?: Record<string, unknown>[] } | null;
      if (!payload || !Array.isArray(payload.jobs)) throw new Error("岗位详情格式不正确");
      return { dataVersion: payload.dataVersion,
        jobs: new Map<string, Record<string, unknown>>(payload.jobs.map((value: Record<string, unknown>) => [String(value.id), value])) };
    });
    detailCache.set(cacheKey, request);
    request.catch(() => detailCache.delete(cacheKey));
  }
  const shard = await request;
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  if (job.dataVersion && shard.dataVersion !== job.dataVersion) {
    detailCache.delete(cacheKey);
    throw new Error("岗位摘要与详情数据版本不一致，请刷新页面后重试");
  }
  const detail = shard.jobs.get(job.id);
  if (!detail) throw new Error("未找到岗位详情，请核验数据版本");
  return { ...job, ...detail } as T;
}
