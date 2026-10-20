export const scale = {
  heading: "3,000 tests. Not 3,000 browsers.",
  intro:
    "Approved tests are balanced into shards by historical duration and run on a bounded, autoscaling worker pool. Plans buy concurrent test slots, not idle servers.",
  totalTests: 3000,
  minutesPerTest: 1,
  // ponytail: fixed overhead guess for the illustration; real startup/queue time varies per environment.
  overheadMinutes: 4,
  workerStops: [5, 25, 50, 100, 200],
  defaultWorkers: 100,
  caveat:
    "Illustration using the formula total duration ÷ workers + overhead, for 3,000 one-minute tests. Real time depends on retries, startup, uneven workloads, serial tests and how much load your environment accepts."
} as const;

export function estimateMinutes(workers: number): number {
  const safeWorkers = Math.max(1, Math.floor(workers));
  return Math.ceil((scale.totalTests * scale.minutesPerTest) / safeWorkers + scale.overheadMinutes);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
