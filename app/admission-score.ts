type AdmissionJob = {
  admitted: { ticket: string }[];
  interviewees: { ticket: string; writtenScore: number | null }[];
};

export function minimumAdmittedWrittenScore(job: AdmissionJob): number | null {
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