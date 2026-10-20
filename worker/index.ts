/** Cloudflare Worker entry point for the vinext-starter template. */
import handler from "vinext/server/app-router-entry";
import { createAnalysisGate } from "./ai-gate";
import { securePublicResponse } from "./http-security";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const admitAnalysis = createAnalysisGate();
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return securePublicResponse(request, async (safeRequest) => {
      if (safeRequest.method === "POST" && new URL(safeRequest.url).pathname === "/api/analyze") {
        const admission = await admitAnalysis(env.DB);
        if (admission instanceof Response) return admission;
        try { return await handler.fetch(safeRequest, env, ctx); }
        finally { await admission.release(); }
      }
      return handler.fetch(safeRequest, env, ctx);
    });
  },
};

export default worker;
