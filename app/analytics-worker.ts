/// <reference lib="webworker" />

import {
  analyzeSelection,
  buildJobMetrics,
  type AnalyticsJob,
  type JobMetric,
} from "./analytics";

type InitMessage = {
  type: "init";
  jobs: AnalyticsJob[];
};

type AnalyzeMessage = {
  type: "analyze";
  requestId: number;
  eligibleIds: string[];
  currentIds: string[];
};

type WorkerMessage = InitMessage | AnalyzeMessage;

let jobsById = new Map<string, AnalyticsJob>();
let metrics = new Map<string, JobMetric>();

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    jobsById = new Map(message.jobs.map((job) => [job.id, job]));
    metrics = buildJobMetrics(message.jobs);
    self.postMessage({
      type: "metrics",
      entries: [...metrics.entries()],
    });
    return;
  }

  self.postMessage({
    type: "started",
    requestId: message.requestId,
  });
  const eligibleJobs = message.eligibleIds
    .map((id) => jobsById.get(id))
    .filter((job): job is AnalyticsJob => Boolean(job));
  const currentJobs = message.currentIds
    .map((id) => jobsById.get(id))
    .filter((job): job is AnalyticsJob => Boolean(job));
  const analytics = analyzeSelection(eligibleJobs, currentJobs, metrics);
  self.postMessage({
    type: "analysis",
    requestId: message.requestId,
    analytics,
  });
};

export {};
