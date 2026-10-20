type AdmissionJob = {
  admitted: { ticket: string }[];
  interviewees: { ticket: string; writtenScore: number | null }[];
  admittedCount?: number;
  minAdmittedWrittenScore?: number | null;
  admissionSummary?: {
    recordedCount: number;
    matchedWrittenCount: number;
    listCompleteness: "unknown" | "confirmed";
    status: "available" | "uncollected" | "association-failed" | "review";
    note: string;
  };
};

export function minimumAdmittedWrittenScore(job: AdmissionJob): number | null {
  if (!job.admitted.length && (job.admittedCount ?? 0) > 0) {
    return typeof job.minAdmittedWrittenScore === "number" && Number.isFinite(job.minAdmittedWrittenScore)
      ? job.minAdmittedWrittenScore : null;
  }
  if (!job.admitted.length) return null;
  const scores: number[] = [];
  for (const admitted of job.admitted) {
    if (!admitted.ticket.trim()) return null;
    const matches = job.interviewees.filter((person) => person.ticket === admitted.ticket);
    const values = [...new Set(matches.map((person) => person.writtenScore).filter(
      (score): score is number => score !== null && Number.isFinite(score),
    ))];
    if (values.length !== 1) return null;
    scores.push(values[0]);
  }
  return Math.min(...scores);
}

export function admissionEvidence(job: AdmissionJob) {
  return job.admissionSummary?.note ??
    `已收录${job.admittedCount ?? job.admitted.length}名录用者。名单完整状态未核实；此值仅为已收录且唯一关联成绩者的最低笔试原值，不是最终录取线。`;
}
