export type AnalysisFilterValue = string | string[] | number | boolean | null;

/** Only non-sensitive query facts belong here. Never include a name, API key or raw personal profile. */
export type AnalysisSnapshot = {
  filters: Record<string, AnalysisFilterValue>;
  jobIds: string[];
  dataVersion: string;
};

export function snapshotKey(snapshot: AnalysisSnapshot): string {
  return JSON.stringify({
    filters: Object.fromEntries(
      Object.entries(snapshot.filters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
    ),
    jobIds: [...snapshot.jobIds].sort(),
    dataVersion: snapshot.dataVersion,
  });
}

/** A cancelled or superseded request can never become the current query's result. */
export function createAnalysisSession() {
  let sequence = 0;
  let active: { id: number; key: string; controller: AbortController } | null = null;
  return {
    begin(snapshot: AnalysisSnapshot) {
      active?.controller.abort();
      const copy: AnalysisSnapshot = {
        filters: Object.fromEntries(Object.entries(snapshot.filters).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])),
        jobIds: [...snapshot.jobIds],
        dataVersion: snapshot.dataVersion,
      };
      active = { id: ++sequence, key: snapshotKey(copy), controller: new AbortController() };
      return { ...active, snapshot: copy };
    },
    cancel() {
      active?.controller.abort();
      active = null;
    },
    isCurrent(id: number, currentSnapshot: AnalysisSnapshot) {
      return active?.id === id && !active.controller.signal.aborted && active.key === snapshotKey(currentSnapshot);
    },
    finish(id: number) {
      if (active?.id === id) active = null;
    },
  };
}
