export const AI_LIMITS = Object.freeze({ perMinute: 30, perDay: 500, concurrency: 4, leaseMs: 150_000 });

export const QUOTA_SQL = `INSERT INTO ai_quota (scope, minute_start, minute_count, day_start, day_count)
VALUES ('global', ?, 1, ?, 1)
ON CONFLICT(scope) DO UPDATE SET
  minute_count = CASE WHEN minute_start = excluded.minute_start THEN minute_count + 1 ELSE 1 END,
  minute_start = excluded.minute_start,
  day_count = CASE WHEN day_start = excluded.day_start THEN day_count + 1 ELSE 1 END,
  day_start = excluded.day_start
WHERE minute_start <= excluded.minute_start AND day_start <= excluded.day_start
  AND (minute_start != excluded.minute_start OR minute_count < ?)
  AND (day_start != excluded.day_start OR day_count < ?)
RETURNING scope`;

export const LEASE_SQL = `INSERT INTO ai_leases (token, expires_at)
SELECT ?, ? WHERE (SELECT COUNT(*) FROM ai_leases WHERE expires_at > ?) < ?
RETURNING token`;

export function gateFailure(status: number, code: string, error: string, retryAfter = 60) {
  return Response.json({ error, code, retryable: true, snapshot: null }, {
    status, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
  });
}

// No client-supplied identity headers. Atomic SQLite writes share budgets and
// leases across isolates; absent/broken storage closes only AI, never querying.
export function createAnalysisGate(deadlineMs = 5_000) {
  let blockedUntil = 0;
  let blockedStatus = 503;
  let localWindow = 0;
  let localAttempts = 0;
  return async function admit(db: D1Database | undefined, now = Date.now()): Promise<Response | { release(): Promise<void> }> {
    if (now < blockedUntil) return gateFailure(blockedStatus, blockedStatus === 429 ? "rate_limited" : "analysis_busy", "AI 分析暂时繁忙或已达配额，请稍后再试；岗位查询不受影响。", Math.max(1, Math.ceil((blockedUntil - now) / 1000)));
    const minute = Math.floor(now / 60_000);
    if (localWindow !== minute) { localWindow = minute; localAttempts = 0; }
    if (++localAttempts > 60) return gateFailure(429, "rate_limited", "AI 分析请求过于频繁，请稍后再试；岗位查询不受影响。");
    if (!db) return gateFailure(503, "analysis_unavailable", "AI 分析暂不可用，请稍后重试；岗位查询不受影响。");
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();
    const unavailable = () => gateFailure(503, "analysis_unavailable", "AI 分析暂不可用，请稍后重试；岗位查询不受影响。", 5);
    const run = async () => {
      const quota = await db.prepare(QUOTA_SQL)
        .bind(minute, Math.floor(now / 86_400_000), AI_LIMITS.perMinute, AI_LIMITS.perDay).first();
      if (expired) return unavailable();
      if (!quota) {
        blockedUntil = (minute + 1) * 60_000;
        blockedStatus = 429;
        return gateFailure(429, "rate_limited", "本站 AI 分析配额已达上限，请稍后再试；岗位查询不受影响。");
      }
      await db.prepare("DELETE FROM ai_leases WHERE expires_at <= ?").bind(now).run();
      if (expired) return unavailable();
      const token = crypto.randomUUID();
      const leaseNow = now + Math.max(0, Date.now() - startedAt);
      const lease = await db.prepare(LEASE_SQL).bind(token, leaseNow + AI_LIMITS.leaseMs, leaseNow, AI_LIMITS.concurrency).first();
      if (!lease) return gateFailure(429, "analysis_busy", "当前 AI 分析人数较多，请稍后再试；岗位查询不受影响。", 15);
      let released = false;
      const admission = { async release() {
        if (released) return;
        released = true;
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            db.prepare("DELETE FROM ai_leases WHERE token = ?").bind(token).run(),
            new Promise<void>((resolve) => { releaseTimer = setTimeout(resolve, 1_000); }),
          ]);
        }
        catch { /* Failed releases expire automatically; never log request data. */ }
        finally { clearTimeout(releaseTimer); }
      } };
      if (expired) { await admission.release(); return unavailable(); }
      return admission;
    };
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error("Gate deadline")); }, deadlineMs);
        }),
      ]);
    } catch {
      blockedUntil = now + Math.max(0, Date.now() - startedAt) + 5_000;
      blockedStatus = 503;
      return unavailable();
    } finally { clearTimeout(timer!); }
  };
}
