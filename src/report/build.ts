import { buildTimeline } from './timeline.js';
import { jiraSummaryMetric, mean, median, METRICS, ruleBound } from './metrics.js';
import { laneColors, THEME } from './theme.js';
import {
  formatDate, formatDateTime, formatDuration, formatDurationCoarse,
  formatRelative, formatUtcStamp, hoursBetween,
} from '../util/time.js';
import type { Store } from '../db/store.js';
import type { HealthConfig } from '../config/types.js';
import type { PullRequestRecord } from '../db/types.js';
import type { SyncResult } from '../sync/index.js';
import type {
  CicdSection, Delta, Direction, EvolutionSection, Indicator, JiraSummariesSection,
  Kpi, NavigationEntry, PipelineItem, PullRequestItem, PullRequestsSection,
  ReportDocument, SummaryGroup, SummarySection, TestingSection, TicketItem, Trend,
} from './model.js';

export interface BuildInput {
  config: HealthConfig;
  store: Store;
  runId: number;
  runNumber: number;
  reportId: string;
  startedAt: Date;
  now: Date;
  sync: SyncResult;
  version: string;
}

const ISSUE_TYPE_INDICATOR: Record<string, Indicator> = {
  bug: 'problem', defect: 'problem', incident: 'problem',
  debt: 'warning', 'technical debt': 'warning', improvement: 'warning',
  task: 'neutral', story: 'neutral', epic: 'neutral', subtask: 'neutral',
};

function issueTypeIndicator(type: string): Indicator {
  return ISSUE_TYPE_INDICATOR[type.trim().toLowerCase()] ?? 'neutral';
}

/** Direction of travel, given whether a lower number is the better one. */
function directionOf(change: number, lowerIsBetter: boolean): Direction {
  if (change === 0) return 'flat';
  return (lowerIsBetter ? change < 0 : change > 0) ? 'better' : 'worse';
}

function lastTwo(series: (number | null)[]): [number, number | null] {
  const current = series[series.length - 1] ?? 0;
  const previous = series.length > 1 ? series[series.length - 2] : null;
  return [current, previous ?? null];
}

function kpiDelta(series: (number | null)[], lowerIsBetter: boolean, previousLabel: string): Delta {
  const [current, previous] = lastTwo(series);
  if (previous === null) {
    return { value: 0, display: 'first run', direction: 'flat' };
  }
  const value = Math.round((current - previous) * 10) / 10;
  return {
    value,
    display: value === 0 ? `no change vs ${previousLabel}` : `${value > 0 ? '+' : ''}${value} vs ${previousLabel}`,
    direction: directionOf(value, lowerIsBetter),
  };
}

function trendDelta(series: (number | null)[], lowerIsBetter: boolean, unit: string): Delta {
  const [current, previous] = lastTwo(series);
  if (previous === null) return { value: 0, display: '—', direction: 'flat' };
  const value = Math.round((current - previous) * 10) / 10;
  return {
    value,
    display: value === 0 ? '—' : `${value > 0 ? '+' : ''}${value}${unit}`,
    direction: directionOf(value, lowerIsBetter),
  };
}

/**
 * Records this run's aggregates, then assembles the report document from the
 * database.
 *
 * Aggregates are written to run_metrics before the series are read back, so
 * the current run is simply the last point of every series rather than a
 * special case the renderer has to append.
 */
export function buildReport(input: BuildInput): ReportDocument {
  const { config, store, runId, runNumber, reportId, startedAt, now, sync, version } = input;
  const { report: settings } = config;

  const pullRequests = config.pullRequests
    ? store.pullRequestsByState(sync.pullRequestRepoIds, config.pullRequests.state)
    : [];
  const pipelines = config.cicd
    ? store.pipelinesSince(sync.cicdRepoIds, sync.cicdSince, config.cicd.maxPipelines)
    : [];
  const pipelineStats = config.cicd
    ? store.pipelineStats(sync.cicdRepoIds, sync.cicdSince)
    : { total: 0, passed: 0, failed: 0, stopped: 0, running: 0, durations: [] as number[] };

  const ages = pullRequests.map((pr) => hoursBetween(pr.createdAt, now));
  const indicatorFor = (hours: number): string | null =>
    config.pullRequests?.ageIndicators.find((i) => i.matches(hours))?.slug ?? null;

  const worstIndicator = config.pullRequests?.ageIndicators.at(-1);
  const overThreshold = worstIndicator
    ? ages.filter((h) => indicatorFor(h) === worstIndicator.slug).length : 0;
  const thresholdBound = worstIndicator ? ruleBound(worstIndicator.rule) : null;

  const turnarounds = pullRequests
    .filter((pr) => pr.firstReviewAt)
    .map((pr) => hoursBetween(pr.createdAt, pr.firstReviewAt as string));

  const completed = pipelineStats.passed + pipelineStats.failed + pipelineStats.stopped;
  const successRate = completed > 0 ? Math.round((pipelineStats.passed / completed) * 100) : 0;
  const medianSeconds = Math.round(median(pipelineStats.durations) / 1000);

  const summaryCounts = new Map(
    config.jiraSummaries.map((s) => [s.slug, store.summaryCount(runId, s.slug)]),
  );
  const jiraTotal = [...summaryCounts.values()].reduce((a, b) => a + b, 0);

  // --- record this run's aggregates ---------------------------------------
  store.transaction(() => {
    if (config.pullRequests) {
      store.setMetric(runId, METRICS.pullRequestsOpen, pullRequests.length);
      store.setMetric(runId, METRICS.pullRequestAvgAge, Math.round(mean(ages)));
      store.setMetric(runId, METRICS.pullRequestsOverThreshold, overThreshold);
      store.setMetric(runId, METRICS.reviewTurnaround,
        turnarounds.length > 0 ? Math.round(mean(turnarounds)) : null);
    }
    if (config.cicd) {
      store.setMetric(runId, METRICS.pipelinesTotal, pipelineStats.total);
      store.setMetric(runId, METRICS.pipelineSuccessRate, successRate);
      store.setMetric(runId, METRICS.pipelineMedianSeconds, medianSeconds);
    }
    if (config.jiraSummaries.length > 0) {
      store.setMetric(runId, METRICS.jiraOpenTotal, jiraTotal);
      for (const [slug, count] of summaryCounts) {
        store.setMetric(runId, jiraSummaryMetric(slug), count);
      }
    }
  });

  // --- history axis --------------------------------------------------------
  const history = store.recentRuns(settings.historyRuns).reverse();
  const runIds = history.map((r) => r.id);
  const series = (metric: string) => store.metricSeries(runIds, metric);

  const previous = store.previousRun(runId);
  const previousLabel = previous ? `#${previous.id}` : '#—';
  const runsRange = history.length > 1
    ? `last ${history.length} runs · runs #${history[0]?.id} → #${runNumber}`
    : 'first run — no history yet';

  const durationSeconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  const repositoryCount = new Set([
    ...(config.pullRequests?.repositories ?? []).map((r) => `${r.integration}/${r.slug}`),
    ...(config.cicd?.repositories ?? []).map((r) => `${r.integration}/${r.slug}`),
  ]).size;

  // The lane order fixes the lane palette, so it is resolved before the theme.
  const laneOrder = config.jiraSummaries[0]?.timelineStatuses
    ?? ['To Do', 'In Progress', 'Code Review', 'QA', 'Done'];

  const document: ReportDocument = {
    version: '1',
    report: {
      id: reportId,
      title: settings.title,
      client_label: settings.clientLabel,
      generated_at: now.toISOString(),
      timezone: settings.timezone,
      locale: settings.locale,
      generator: { name: '@lab34/health', version },
      run: {
        number: runNumber,
        started_at: startedAt.toISOString(),
        finished_at: now.toISOString(),
        duration_seconds: durationSeconds,
        duration_display: formatDuration(durationSeconds),
      },
      previous_run: previous
        ? { number: previous.id, generated_at: previous.finished_at ?? previous.started_at }
        : null,
      scope: {
        integrations: config.integrations.length,
        repositories: repositoryCount,
        jira_summaries: config.jiraSummaries.length,
      },
      meta_display: [
        `run #${runNumber}`,
        formatUtcStamp(now),
        `synced ${formatDuration(durationSeconds)}`,
        `${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}`,
      ].join(' · '),
      footer: {
        left: `reports/${reportId}/index.html · index.yaml alongside`,
        right: 'lab34/health · @lab34/health',
      },
      warnings: sync.warnings,
    },
    theme: { ...THEME, lanes: laneColors(laneOrder) },
    navigation: [],
    runs: history.map((r) => ({ number: r.id, generated_at: r.finished_at ?? r.started_at })),
    summary: buildSummary(),
    evolution: buildEvolution(),
    pull_requests: config.pullRequests ? buildPullRequests() : null,
    cicd: config.cicd ? buildCicd() : null,
    testing: buildTesting(),
    jira_summaries: buildJiraSummaries(),
  };

  document.navigation = buildNavigation(document);
  // Sections carry the same number the contents bar shows them under, which
  // shifts when an unconfigured section is absent.
  for (const entry of document.navigation) {
    const section = document[entry.ref as keyof ReportDocument] as { index: string } | null;
    if (section) section.index = entry.index;
  }
  return document;

  // --- sections ------------------------------------------------------------

  function buildSummary(): SummarySection {
    const kpis: Kpi[] = [];

    const add = (
      id: string, label: string, unit: string, metric: string, lowerIsBetter: boolean,
    ): void => {
      const values = series(metric);
      const [current] = lastTwo(values);
      kpis.push({
        id, label, unit, lower_is_better: lowerIsBetter,
        value: current,
        display: String(current),
        series: values,
        delta: kpiDelta(values, lowerIsBetter, previousLabel),
      });
    };

    if (config.pullRequests) {
      add('open_pull_requests', 'Open pull requests', pullRequests.length === 1 ? 'PR' : 'PRs',
        METRICS.pullRequestsOpen, true);
      add('average_pr_age', 'Average PR age', 'hours', METRICS.pullRequestAvgAge, true);
      add('prs_over_threshold',
        thresholdBound === null ? `PRs marked ${worstIndicator?.slug ?? 'late'}` : `PRs over ${thresholdBound}h`,
        `of ${pullRequests.length}`, METRICS.pullRequestsOverThreshold, true);
    }
    if (config.cicd) add('pipeline_success', 'Pipeline success', '%', METRICS.pipelineSuccessRate, false);
    if (config.jiraSummaries.length > 0) {
      add('open_tech_debt', 'Open Jira items', 'tickets', METRICS.jiraOpenTotal, true);
    }

    return {
      id: 'summary', index: '01', title: 'Summary',
      note: previous
        ? `Deltas compare against run ${previousLabel} (${formatUtcStamp(previous.finished_at ?? previous.started_at)}). Green means the metric moved the right way.`
        : 'First run — there is nothing to compare against yet.',
      kpis,
    };
  }

  function buildEvolution(): EvolutionSection {
    const trends: Trend[] = [];

    const add = (
      id: string, name: string, hint: string, unit: string, metric: string,
      lowerIsBetter: boolean, transform: (value: number) => number = (v) => v,
    ): void => {
      const values = series(metric).map((v) => (v === null ? null : transform(v)));
      const [current] = lastTwo(values);
      trends.push({
        id, name, hint, unit, lower_is_better: lowerIsBetter, series: values,
        current: { value: current, display: `${current}${unit}` },
        delta: trendDelta(values, lowerIsBetter, unit),
      });
    };

    if (config.pullRequests) {
      add('average_pr_age', 'Average PR age', 'hours open', 'h', METRICS.pullRequestAvgAge, true);
      add('open_pull_requests', 'PRs open at run time',
        `across ${config.pullRequests.repositories.length} ${config.pullRequests.repositories.length === 1 ? 'repository' : 'repositories'}`,
        '', METRICS.pullRequestsOpen, true);
      add('review_turnaround', 'Review turnaround', 'hours to first review', 'h',
        METRICS.reviewTurnaround, true);
    }
    if (config.cicd) {
      add('pipeline_success', 'Pipeline success rate', 'passed / completed pipelines', '%',
        METRICS.pipelineSuccessRate, false);
      add('pipeline_duration', 'Pipeline duration', 'median, minutes', 'm',
        METRICS.pipelineMedianSeconds, true, (v) => Math.round(v / 60));
    }
    if (config.jiraSummaries.length > 0) {
      add('jira_backlog', 'Jira backlog',
        `open across ${config.jiraSummaries.length} ${config.jiraSummaries.length === 1 ? 'summary' : 'summaries'}`,
        '', METRICS.jiraOpenTotal, true);
    }

    return {
      id: 'evolution', index: '02', title: 'Evolution',
      enabled: settings.showEvolution && history.length > 1,
      range_display: runsRange,
      legend: [
        { label: 'bars = one run, oldest left', direction: null },
        { label: 'improving', direction: 'better' },
        { label: 'worsening', direction: 'worse' },
        { label: 'flat', direction: 'flat' },
      ],
      trends: settings.showEvolution ? trends : [],
    };
  }

  function buildPullRequests(): PullRequestsSection {
    const section = config.pullRequests as NonNullable<HealthConfig['pullRequests']>;
    const oldest = ages.length > 0 ? Math.max(...ages) : 0;
    const averageAge = Math.round(mean(ages));

    const headlineParts = [
      `Average PR age ${averageAge}h`,
      `${pullRequests.length} ${section.state === 'OPEN' ? 'open' : section.state.toLowerCase()}`,
    ];
    if (thresholdBound !== null) {
      headlineParts.push(`${overThreshold} over the ${thresholdBound}h threshold`);
    }
    if (ages.length > 0) headlineParts.push(`oldest ${oldest}h`);

    return {
      id: 'pullrequests', index: '03', title: section.title, state: section.state,
      headline: {
        display: pullRequests.length === 0
          ? `No ${section.state.toLowerCase()} pull requests across ${section.repositories.length} repositories`
          : headlineParts.join(' · '),
        average_age_hours: averageAge,
        open_count: pullRequests.length,
        over_threshold_count: overThreshold,
        oldest_age_hours: oldest,
      },
      age_indicators: section.ageIndicators.map((indicator) => {
        const bound = ruleBound(indicator.rule);
        const operator = indicator.rule.trim().startsWith('>') ? '>' : '<';
        return {
          slug: indicator.slug,
          rule: indicator.rule,
          label: bound === null ? indicator.slug : `${indicator.slug} ${operator} ${bound}h`,
          color: indicator.color,
        };
      }),
      columns: [
        { key: 'repository', label: 'Repository', align: 'left', sortable: true },
        { key: 'title', label: 'Pull request', align: 'left', sortable: true },
        { key: 'author', label: 'Author', align: 'left', sortable: true },
        { key: 'age', label: 'Age', align: 'right', sortable: true },
        { key: 'changes', label: 'Changes', align: 'right', sortable: true },
        { key: 'commits', label: 'Commits', align: 'right', sortable: true },
        { key: 'reviewers', label: 'Reviewers', align: 'left', sortable: false },
        { key: 'expand', label: '', align: 'right', sortable: false },
      ],
      default_sort: { key: 'age', direction: 'desc' },
      items: pullRequests
        .map((pr) => buildPullRequestItem(pr))
        .sort((a, b) => b.age_hours - a.age_hours),
    };
  }

  function buildPullRequestItem(pr: PullRequestRecord): PullRequestItem {
    const ageHours = hoursBetween(pr.createdAt, now);
    const indicator = indicatorFor(ageHours);
    const ageSeverity: Indicator = severityOfAge(indicator);

    const changesDetail = `${pr.filesChanged} ${pr.filesChanged === 1 ? 'file' : 'files'} · +${pr.linesAdded} / −${pr.linesRemoved}`;
    const commentsDisplay = pr.commentCount === 0
      ? '0'
      : pr.unresolvedCount === 0
        ? `${pr.commentCount} · all resolved`
        : `${pr.commentCount} · ${pr.unresolvedCount} unresolved ${pr.unresolvedCount === 1 ? 'thread' : 'threads'}`;

    const blocking = blockingState(pr);
    const createdDisplay = formatDateTime(pr.createdAt, settings.timezone);

    return {
      id: `${pr.repositorySlug}#${pr.number}`,
      repository: pr.repositoryName,
      repository_slug: pr.repositorySlug,
      integration: pr.integrationId,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: { name: pr.author, display_name: pr.authorDisplay },
      created_at: pr.createdAt,
      created_display: createdDisplay,
      updated_at: pr.updatedAt,
      age_hours: ageHours,
      age_display: `${ageHours}h`,
      age_indicator: indicator,
      source_branch: pr.sourceBranch,
      destination_branch: pr.destinationBranch,
      branches_display: `${pr.sourceBranch} → ${pr.destinationBranch}`,
      changes: {
        files: pr.filesChanged,
        lines_added: pr.linesAdded,
        lines_removed: pr.linesRemoved,
        lines_total: pr.linesAdded + pr.linesRemoved,
        display: `${pr.filesChanged}f · ${pr.linesAdded + pr.linesRemoved}l`,
        detail_display: changesDetail,
      },
      comments: { total: pr.commentCount, unresolved: pr.unresolvedCount, display: commentsDisplay },
      blocking,
      reviewers: pr.reviewers.map((reviewer) => ({
        name: reviewer.userName,
        state: reviewer.state,
        label: `${reviewer.userName} ${reviewerWord(reviewer.state)}`,
        indicator: reviewerIndicator(reviewer.state),
        updated_at: reviewer.updatedAt,
      })),
      commits: pr.commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message,
        author: commit.author,
        committed_at: commit.committedAt,
        when_display: commit.committedAt ? formatRelative(commit.committedAt, now) : '',
      })),
      facts: [
        { key: 'Created', value: `${createdDisplay} · ${ageHours}h open`, indicator: ageSeverity },
        { key: 'Files changed', value: changesDetail, indicator: 'neutral' },
        { key: 'Comments', value: commentsDisplay, indicator: pr.unresolvedCount > 0 ? 'warning' : 'neutral' },
        { key: 'Blocking', value: blocking.display, indicator: blocking.indicator },
      ],
    };
  }

  function severityOfAge(slug: string | null): Indicator {
    if (!slug || !config.pullRequests) return 'neutral';
    const indicators = config.pullRequests.ageIndicators;
    const index = indicators.findIndex((i) => i.slug === slug);
    if (index < 0) return 'neutral';
    if (index === indicators.length - 1 && indicators.length > 1) return 'problem';
    return index === 0 ? 'ok' : 'warning';
  }

  function buildCicd(): CicdSection {
    const section = config.cicd as NonNullable<HealthConfig['cicd']>;
    const headline = pipelineStats.total === 0
      ? `No pipelines in the last ${section.windowHours}h`
      : [
        `${pipelineStats.total} ${pipelineStats.total === 1 ? 'pipeline' : 'pipelines'} in the last ${section.windowHours}h`,
        `${pipelineStats.passed} passed`,
        `${pipelineStats.failed} failed`,
        `median duration ${formatDurationCoarse(medianSeconds)}`,
      ].join(' · ');

    return {
      id: 'cicd', index: '04', title: section.title,
      headline: {
        display: headline,
        window_hours: section.windowHours,
        total: pipelineStats.total,
        passed: pipelineStats.passed,
        failed: pipelineStats.failed,
        stopped: pipelineStats.stopped,
        running: pipelineStats.running,
        success_rate: successRate,
        median_duration_seconds: medianSeconds,
        median_duration_display: formatDurationCoarse(medianSeconds),
      },
      columns: [
        { key: 'repository', label: 'Repository', align: 'left' },
        { key: 'name', label: 'Pipeline / branch', align: 'left' },
        { key: 'triggered_by', label: 'Triggered by', align: 'left' },
        { key: 'when', label: 'When', align: 'left' },
        { key: 'duration', label: 'Duration', align: 'right' },
        { key: 'outcome', label: 'Outcome', align: 'left' },
        { key: 'steps', label: 'Steps', align: 'left' },
      ],
      step_outcomes: {
        passed: { indicator: 'ok' },
        failed: { indicator: 'problem' },
        skipped: { indicator: 'neutral' },
        running: { indicator: 'warning' },
      },
      items: pipelines.map((pipeline): PipelineItem => {
        const failed = pipeline.steps.filter((s) => s.outcome === 'failed').map((s) => s.name);
        const skipped = pipeline.steps.filter((s) => s.outcome === 'skipped').map((s) => s.name);
        const notes: string[] = [];
        if (failed.length > 0) notes.push(`failed: ${failed.join(', ')}`);
        if (skipped.length > 0) notes.push(`skipped: ${skipped.join(', ')}`);
        const seconds = pipeline.durationMs === null ? null : Math.round(pipeline.durationMs / 1000);

        return {
          id: `${pipeline.repositorySlug}#${pipeline.number}`,
          repository: pipeline.repositoryName,
          repository_slug: pipeline.repositorySlug,
          integration: pipeline.integrationId,
          number: pipeline.number,
          name: pipeline.name,
          branch: pipeline.branch,
          commit: pipeline.commitSha,
          triggered_by: pipeline.triggeredBy,
          trigger_type: pipeline.triggerType,
          created_at: pipeline.createdAt,
          when_display: formatRelative(pipeline.createdAt, now),
          duration_seconds: seconds,
          duration_display: seconds === null ? '—' : formatDuration(seconds),
          outcome: pipeline.outcome,
          outcome_indicator: pipeline.outcome === 'PASSED' ? 'ok'
            : pipeline.outcome === 'FAILED' ? 'problem' : 'neutral',
          url: pipeline.url,
          note: {
            display: notes.length > 0
              ? notes.join(' · ')
              : `all ${pipeline.steps.length} ${pipeline.steps.length === 1 ? 'step' : 'steps'} passed`,
            indicator: failed.length > 0 ? 'problem' : 'neutral',
          },
          failed_steps: failed,
          skipped_steps: skipped,
          steps: pipeline.steps.map((step) => ({
            name: step.name,
            outcome: step.outcome,
            duration_seconds: Math.round(step.durationMs / 1000),
          })),
        };
      }),
    };
  }

  function buildTesting(): TestingSection {
    return {
      id: 'testing', index: '05', title: config.testing.title, status: 'empty',
      placeholder: { message: config.testing.placeholder, hint: config.testing.hint },
      suites: [],
    };
  }

  function buildJiraSummaries(): JiraSummariesSection {
    const items: SummaryGroup[] = config.jiraSummaries.map((summary) => {
      const issues = store.issuesForSummary(runId, summary.slug);
      const count = issues.length;

      return {
        slug: summary.slug,
        title: summary.title,
        jql: summary.jql,
        integration: summary.integration,
        count,
        count_display: `${count} ${count === 1 ? 'ticket' : 'tickets'}`,
        series: series(jiraSummaryMetric(summary.slug)),
        empty_display: 'No tickets match the search.',
        tickets: issues.map((issue): TicketItem => {
          const timeline = buildTimeline({
            createdAt: issue.createdAt,
            resolvedAt: issue.resolvedAt,
            now,
            currentStatus: issue.status,
            currentAssignee: issue.assignee,
            changes: issue.changes,
            laneOrder: summary.timelineStatuses,
          });

          const who = issue.assignee ?? 'unassigned';
          const when = issue.resolvedAt
            ? `closed ${formatRelative(issue.resolvedAt, now)}`
            : `opened ${formatRelative(issue.createdAt, now)}`;

          return {
            key: issue.key,
            type: issue.type,
            title: issue.title,
            url: issue.url,
            description: issue.description,
            status: issue.status,
            status_category: issue.statusCategory,
            assignee: issue.assignee,
            reporter: issue.reporter,
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
            resolved_at: issue.resolvedAt,
            meta_display: `${who} · ${when}`,
            timeline: {
              start: timeline.start,
              end: timeline.end,
              axis_start_display: formatDate(timeline.start, settings.timezone),
              axis_end_display: formatDate(timeline.end, settings.timezone),
              total_hours: timeline.totalHours,
              lanes: timeline.lanes.map((lane) => ({
                status: lane.status,
                hours: lane.hours,
                time_display: lane.timeDisplay,
                share: lane.share,
                emphasis: lane.emphasis,
                who: lane.who,
                segments: lane.segments.map((segment) => ({
                  start_hours: segment.startHours,
                  duration_hours: segment.durationHours,
                  who: segment.who,
                  entered_at: segment.enteredAt,
                  left_at: segment.leftAt,
                  title: segment.title,
                })),
              })),
            },
          };
        }),
      };
    });

    const tickets = items.reduce((a, s) => a + s.count, 0);
    const types: Record<string, { indicator: Indicator }> = {};
    for (const item of items) {
      for (const ticket of item.tickets) types[ticket.type] = { indicator: issueTypeIndicator(ticket.type) };
    }

    return {
      id: 'jira', index: '06', title: 'Jira summaries',
      search: {
        enabled: tickets > 0,
        placeholder: 'Search tickets…',
        fields: ['key', 'title', 'status', 'meta_display', 'description'],
      },
      totals: {
        tickets,
        summaries: items.length,
        display: `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'} across ${items.length} ${items.length === 1 ? 'summary' : 'summaries'}`,
      },
      timeline: { statuses: laneOrder, heavy_share: 0.35, empty_display: '—' },
      types,
      items,
    };
  }
}

function reviewerWord(state: string): string {
  if (state === 'approved') return 'approved';
  if (state === 'changes_requested') return 'changes';
  return 'pending';
}

function reviewerIndicator(state: string): Indicator {
  if (state === 'approved') return 'ok';
  if (state === 'changes_requested') return 'problem';
  return 'warning';
}

/** What a pull request is waiting on, in the order that matters. */
function blockingState(pr: PullRequestRecord): { state: string; indicator: Indicator; display: string } {
  const blockers = pr.reviewers.filter((r) => r.state === 'changes_requested');
  if (blockers.length > 0) {
    return {
      state: 'changes_requested',
      indicator: 'problem',
      display: `changes requested by ${blockers.map((r) => r.userName).join(', ')}`,
    };
  }
  if (pr.reviewers.length === 0) {
    return { state: 'no_reviewers', indicator: 'warning', display: 'no reviewers assigned' };
  }
  const pending = pr.reviewers.filter((r) => r.state === 'pending');
  if (pending.length === pr.reviewers.length) {
    return { state: 'awaiting_review', indicator: 'warning', display: 'awaiting first review' };
  }
  if (pending.length > 0) {
    return {
      state: 'review_missing',
      indicator: 'warning',
      display: pending.length === 1 ? 'one review missing' : `${pending.length} reviews missing`,
    };
  }
  if (pr.unresolvedCount > 0) {
    return {
      state: 'unresolved_threads',
      indicator: 'warning',
      display: `${pr.unresolvedCount} unresolved ${pr.unresolvedCount === 1 ? 'thread' : 'threads'}`,
    };
  }
  return { state: 'none', indicator: 'ok', display: 'nothing — ready to merge' };
}

function buildNavigation(document: ReportDocument): NavigationEntry[] {
  const entries: NavigationEntry[] = [
    { index: '01', id: 'summary', label: 'Summary', ref: 'summary' },
  ];
  if (document.evolution.enabled) {
    entries.push({ index: '02', id: 'evolution', label: 'Evolution', ref: 'evolution' });
  }
  if (document.pull_requests) {
    entries.push({ index: '03', id: 'pullrequests', label: document.pull_requests.title, ref: 'pull_requests' });
  }
  if (document.cicd) {
    entries.push({ index: '04', id: 'cicd', label: document.cicd.title, ref: 'cicd' });
  }
  entries.push({ index: '05', id: 'testing', label: document.testing.title, ref: 'testing' });
  if (document.jira_summaries.items.length > 0) {
    entries.push({ index: '06', id: 'jira', label: 'Jira summaries', ref: 'jira_summaries' });
  }

  // Renumber so the contents bar never shows a gap where a section is absent.
  return entries.map((entry, index) => ({ ...entry, index: String(index + 1).padStart(2, '0') }));
}
