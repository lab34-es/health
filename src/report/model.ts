/**
 * The shape of reports/<id>/index.yaml.
 *
 * Field names are snake_case because these objects are serialised straight to
 * YAML: the model is the document, so there is no mapping layer to drift out of
 * sync with docs/formats.md.
 */

export type Indicator = 'ok' | 'warning' | 'problem' | 'neutral';
export type Direction = 'better' | 'worse' | 'flat';
export type Emphasis = 'normal' | 'heavy' | 'empty';

export interface Delta { value: number; display: string; direction: Direction }

export interface ReportMeta {
  id: string;
  title: string;
  client_label: string;
  generated_at: string;
  timezone: string;
  locale: string;
  generator: { name: string; version: string };
  run: {
    number: number; started_at: string; finished_at: string;
    duration_seconds: number; duration_display: string;
  };
  previous_run: { number: number; generated_at: string } | null;
  scope: { integrations: number; repositories: number; jira_summaries: number };
  meta_display: string;
  footer: { left: string; right: string };
  warnings: string[];
}

export interface Theme {
  palette: Record<string, string>;
  indicator: Record<Indicator, string>;
  direction: Record<Direction, string>;
  named: Record<string, string>;
  /** One colour per configured timeline lane, keyed by status name. */
  lanes: Record<string, string>;
}

export interface NavigationEntry { index: string; id: string; label: string; ref: string }
export interface RunAxisEntry { number: number; generated_at: string }

export interface Kpi {
  id: string;
  label: string;
  value: number;
  display: string;
  unit: string;
  lower_is_better: boolean;
  series: (number | null)[];
  delta: Delta;
}

export interface SummarySection {
  id: string; index: string; title: string; note: string; kpis: Kpi[];
}

export interface Trend {
  id: string; name: string; hint: string; unit: string; lower_is_better: boolean;
  series: (number | null)[];
  current: { value: number; display: string };
  delta: Delta;
}

export interface EvolutionSection {
  id: string; index: string; title: string; enabled: boolean; range_display: string;
  legend: { label: string; direction: Direction | null }[];
  trends: Trend[];
}

export interface PullRequestItem {
  id: string;
  repository: string; repository_slug: string; integration: string;
  number: number; title: string; url: string | null; state: string;
  author: { name: string; display_name: string | null };
  created_at: string; created_display: string; updated_at: string;
  age_hours: number; age_display: string; age_indicator: string | null;
  source_branch: string; destination_branch: string; branches_display: string;
  changes: {
    files: number; lines_added: number; lines_removed: number; lines_total: number;
    display: string; detail_display: string;
  };
  comments: { total: number; unresolved: number; display: string };
  blocking: { state: string; indicator: Indicator; display: string };
  reviewers: {
    name: string; state: string; label: string; indicator: Indicator; updated_at: string | null;
  }[];
  commits: {
    sha: string; message: string; author: string | null;
    committed_at: string | null; when_display: string;
  }[];
  facts: { key: string; value: string; indicator: Indicator }[];
}

export interface PullRequestsSection {
  id: string; index: string; title: string; state: string;
  headline: {
    display: string; average_age_hours: number; open_count: number;
    over_threshold_count: number; oldest_age_hours: number;
  };
  age_indicators: { slug: string; rule: string; label: string; color: string }[];
  columns: { key: string; label: string; align: 'left' | 'right'; sortable: boolean }[];
  default_sort: { key: string; direction: 'asc' | 'desc' };
  items: PullRequestItem[];
}

export interface PipelineItem {
  id: string;
  repository: string; repository_slug: string; integration: string;
  number: number; name: string; branch: string; commit: string | null;
  triggered_by: string; trigger_type: string | null;
  created_at: string; when_display: string;
  duration_seconds: number | null; duration_display: string;
  outcome: string; outcome_indicator: Indicator; url: string | null;
  note: { display: string; indicator: Indicator };
  failed_steps: string[]; skipped_steps: string[];
  steps: { name: string; outcome: string; duration_seconds: number }[];
}

export interface CicdSection {
  id: string; index: string; title: string;
  headline: {
    display: string; window_hours: number; total: number; passed: number; failed: number;
    stopped: number; running: number; success_rate: number;
    median_duration_seconds: number; median_duration_display: string;
  };
  columns: { key: string; label: string; align: 'left' | 'right' }[];
  step_outcomes: Record<string, { indicator: Indicator }>;
  items: PipelineItem[];
}

export interface TestingSection {
  id: string; index: string; title: string; status: 'empty' | 'ok';
  placeholder: { message: string; hint: string };
  suites: unknown[];
}

export interface TicketItem {
  key: string; type: string; title: string; url: string | null;
  description: string | null; status: string; status_category: string | null;
  assignee: string | null; reporter: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
  meta_display: string;
  timeline: {
    start: string; end: string;
    axis_start_display: string; axis_end_display: string;
    total_hours: number;
    lanes: {
      status: string; hours: number; time_display: string; share: number;
      emphasis: Emphasis; who: string;
      segments: {
        start_hours: number; duration_hours: number; who: string;
        entered_at: string; left_at: string; title: string;
      }[];
    }[];
  };
}

export interface SummaryGroup {
  slug: string; title: string; jql: string; integration: string;
  count: number; count_display: string;
  series: (number | null)[];
  empty_display: string;
  tickets: TicketItem[];
}

export interface JiraSummariesSection {
  id: string; index: string; title: string;
  search: { enabled: boolean; placeholder: string; fields: string[] };
  totals: { tickets: number; summaries: number; display: string };
  timeline: { statuses: string[]; heavy_share: number; empty_display: string };
  types: Record<string, { indicator: Indicator }>;
  items: SummaryGroup[];
}

export interface ReportDocument {
  version: '1';
  report: ReportMeta;
  theme: Theme;
  navigation: NavigationEntry[];
  runs: RunAxisEntry[];
  summary: SummarySection;
  evolution: EvolutionSection;
  pull_requests: PullRequestsSection | null;
  cicd: CicdSection | null;
  testing: TestingSection;
  jira_summaries: JiraSummariesSection;
}
