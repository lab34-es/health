/** Metric keys stored in run_metrics, one row per run. */
export const METRICS = {
  pullRequestsOpen: 'pull_requests.open',
  pullRequestAvgAge: 'pull_requests.avg_age_hours',
  pullRequestsOverThreshold: 'pull_requests.over_threshold',
  reviewTurnaround: 'pull_requests.review_turnaround_hours',
  pipelinesTotal: 'pipelines.total',
  pipelineSuccessRate: 'pipelines.success_rate',
  pipelineMedianSeconds: 'pipelines.median_duration_seconds',
  jiraOpenTotal: 'jira.open_total',
} as const;

export function jiraSummaryMetric(slug: string): string {
  return `jira.summary.${slug}.count`;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : sorted[middle] as number;
}

/** The numeric bound in an age rule like "> 48", for labelling. */
export function ruleBound(rule: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*$/.exec(rule.trim());
  return match ? Number(match[1]) : null;
}
