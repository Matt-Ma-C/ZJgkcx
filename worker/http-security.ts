export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

export function checkPublicRequest(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { return new Response("Bad Request", { status: 400 }); }
  if (decodedPath === "/_vinext/image" || decodedPath.startsWith("/_vinext/image/")) return new Response("Not Found", { status: 404 });
  // No business Server Actions or other write routes. Reject before decoding.
  if (request.method === "GET" || request.method === "HEAD") return null;
  if (request.method === "POST" && pathname === "/api/analyze") {
    if (request.signal.aborted) return new Response("分析已取消。", { status: 499 });
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: "请从本站页面发起分析。", code: "invalid_origin", retryable: false, snapshot: null }, { status: 403 });
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) {
      return Response.json({ error: "分析请求必须使用 JSON。", code: "unsupported_media_type", retryable: false, snapshot: null }, { status: 415 });
    }
    if (["next-action", "rsc-action-id", "x-rsc-action"].some((name) => request.headers.has(name))) return new Response("Bad Request", { status: 400 });
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 3_000_000)) {
      return Response.json({ error: "请求内容过大或长度无效。", code: "invalid_request", retryable: false, snapshot: null }, { status: 413 });
    }
    return null;
  }
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
}

export async function securePublicResponse(request: Request, handle: (safeRequest: Request) => Promise<Response>) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  // Vinext propagates this fresh nonce to SSR, bootstrap and Flight scripts.
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.delete("Content-Security-Policy-Report-Only");
  requestHeaders.delete("x-forwarded-for");
  requestHeaders.delete("x-real-ip");
  const safeRequest = new Request(request, { headers: requestHeaders });
  let response: Response;
  try { response = checkPublicRequest(safeRequest) ?? await handle(safeRequest); }
  catch { response = new Response("服务暂时繁忙，请稍后重试。", { status: 503 }); }
  // Rejected requests (including storage/quota failures) must not leave an
  // unread upload holding a connection or stream after an early response.
  if (safeRequest.body && !safeRequest.bodyUsed) void safeRequest.body.cancel().catch(() => undefined);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.delete("X-Powered-By");
  if (headers.get("content-type")?.includes("text/html") || new URL(request.url).pathname.startsWith("/api/") || response.status >= 400) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
