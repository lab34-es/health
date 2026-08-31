import type { Db } from './index.js';
import type {
  CommitInput, JiraIssueInput, JiraIssueRecord, PipelineInput, PipelineRecord,
  IssueChangeInput, PullRequestDetail, PullRequestInput, PullRequestRecord,
  ReviewerInput, RunRow, StepInput,
} from './types.js';

export const LAST_RUN_AT = 'last_run_at';

/** Typed access to the context database. All writes go through here. */
export class Store {
  constructor(private readonly db: Db) {}

  /** Runs `fn` inside a transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- meta ----------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getLastRunAt(): string | undefined {
    return this.getMeta(LAST_RUN_AT);
  }

  // --- runs ----------------------------------------------------------------

  reportIdExists(reportId: string): boolean {
    return this.db.prepare('SELECT 1 FROM runs WHERE report_id = ?').get(reportId) !== undefined;
  }

  beginRun(reportId: string, startedAt: string): number {
    const info = this.db
      .prepare("INSERT INTO runs (report_id, started_at, status) VALUES (?, ?, 'running')")
      .run(reportId, startedAt);
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, finishedAt: string, durationMs: number, status: 'ok' | 'failed', error?: string): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, duration_ms = ?, status = ?, error = ? WHERE id = ?')
      .run(finishedAt, durationMs, status, error ?? null, runId);
  }

  /** Successful runs, newest first, including the one in progress. */
  recentRuns(limit: number): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE status IN ('ok', 'running') ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(limit) as RunRow[];
  }

  previousRun(beforeRunId: number): RunRow | undefined {
    return this.db
      .prepare("SELECT * FROM runs WHERE id < ? AND status = 'ok' ORDER BY id DESC LIMIT 1")
      .get(beforeRunId) as RunRow | undefined;
  }

  /** Drops runs beyond the retention window; metrics cascade with them. */
  pruneRuns(keep: number): number {
    if (keep <= 0) return 0;
    const info = this.db
      .prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)')
      .run(keep);
    return info.changes;
  }

  // --- metrics -------------------------------------------------------------

  setMetric(runId: number, metric: string, value: number | null): void {
    this.db.prepare(
      'INSERT INTO run_metrics (run_id, metric, value) VALUES (?, ?, ?) '
      + 'ON CONFLICT (run_id, metric) DO UPDATE SET value = excluded.value',
    ).run(runId, metric, value);
  }

  /** Values for `metric` across the given runs, in the order the runs are given. */
  metricSeries(runIds: number[], metric: string): (number | null)[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT run_id, value FROM run_metrics WHERE metric = ? AND run_id IN (${placeholders})`)
      .all(metric, ...runIds) as { run_id: number; value: number | null }[];
    const byRun = new Map(rows.map((r) => [r.run_id, r.value]));
    return runIds.map((id) => byRun.get(id) ?? null);
  }

  // --- incremental sync watermarks ----------------------------------------

  getSyncState(scope: string): string | undefined {
    const row = this.db.prepare('SELECT last_synced_at FROM sync_state WHERE scope = ?').get(scope) as
      { last_synced_at: string | null } | undefined;
    return row?.last_synced_at ?? undefined;
  }

  setSyncState(scope: string, lastSyncedAt: string, runId: number): void {
    this.db.prepare(
      'INSERT INTO sync_state (scope, last_synced_at, last_run_id) VALUES (?, ?, ?) '
      + 'ON CONFLICT (scope) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_run_id = excluded.last_run_id',
    ).run(scope, lastSyncedAt, runId);
  }

  // --- repositories --------------------------------------------------------

  upsertRepository(integrationId: string, slug: string, name: string): number {
    this.db.prepare(
      'INSERT INTO repositories (integration_id, slug, name) VALUES (?, ?, ?) '
      + 'ON CONFLICT (integration_id, slug) DO UPDATE SET name = excluded.name',
    ).run(integrationId, slug, name);
    const row = this.db.prepare('SELECT id FROM repositories WHERE integration_id = ? AND slug = ?')
      .get(integrationId, slug) as { id: number };
    return row.id;
  }

  // --- pull requests -------------------------------------------------------

  upsertPullRequest(input: PullRequestInput): number {
    this.db.prepare(`
      INSERT INTO pull_requests (
        repository_id, number, title, description, state, author, author_display,
        source_branch, destination_branch, url, created_at, updated_at, closed_at, merged_at
      ) VALUES (
        @repositoryId, @number, @title, @description, @state, @author, @authorDisplay,
        @sourceBranch, @destinationBranch, @url, @createdAt, @updatedAt, @closedAt, @mergedAt
      )
      ON CONFLICT (repository_id, number) DO UPDATE SET
        title = excluded.title, description = excluded.description, state = excluded.state,
        author = excluded.author, author_display = excluded.author_display,
        source_branch = excluded.source_branch, destination_branch = excluded.destination_branch,
        url = excluded.url, updated_at = excluded.updated_at,
        closed_at = excluded.closed_at, merged_at = excluded.merged_at
    `).run(input as unknown as Record<string, unknown>);
    const row = this.db.prepare('SELECT id FROM pull_requests WHERE repository_id = ? AND number = ?')
      .get(input.repositoryId, input.number) as { id: number };
    return row.id;
  }

  /** True when the stored detail predates the pull request's latest change. */
  needsDetail(pullRequestId: number, updatedAt: string): boolean {
    const row = this.db.prepare('SELECT detail_fetched_at FROM pull_requests WHERE id = ?')
      .get(pullRequestId) as { detail_fetched_at: string | null } | undefined;
    const fetched = row?.detail_fetched_at;
    return !fetched || fetched < updatedAt;
  }

  savePullRequestDetail(
    pullRequestId: number, detail: PullRequestDetail,
    commits: CommitInput[], reviewers: ReviewerInput[], fetchedAt: string,
  ): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE pull_requests SET
          first_review_at = @firstReviewAt, files_changed = @filesChanged,
          lines_added = @linesAdded, lines_removed = @linesRemoved,
          comment_count = @commentCount, unresolved_count = @unresolvedCount,
          detail_fetched_at = @fetchedAt
        WHERE id = @id
      `).run({ ...detail, fetchedAt, id: pullRequestId });

      // Commits and reviewers are replaced wholesale: a force-push or a
      // withdrawn review makes a merge the wrong shape of update.
      this.db.prepare('DELETE FROM pull_request_commits WHERE pull_request_id = ?').run(pullRequestId);
      const insertCommit = this.db.prepare(
        'INSERT INTO pull_request_commits (pull_request_id, sha, message, author, committed_at, position) VALUES (?, ?, ?, ?, ?, ?)',
      );
      commits.forEach((c, i) => insertCommit.run(pullRequestId, c.sha, c.message, c.author, c.committedAt, i));

      this.db.prepare('DELETE FROM pull_request_reviewers WHERE pull_request_id = ?').run(pullRequestId);
      const insertReviewer = this.db.prepare(
        'INSERT INTO pull_request_reviewers (pull_request_id, user_name, display_name, state, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of reviewers) insertReviewer.run(pullRequestId, r.userName, r.displayName, r.state, r.updatedAt);
    });
  }

  /** Marks pull requests absent from a full OPEN listing as no longer open. */
  closeMissingOpenPullRequests(repositoryId: number, presentNumbers: number[]): number {
    const placeholders = presentNumbers.map(() => '?').join(', ');
    const sql = presentNumbers.length > 0
      ? `UPDATE pull_requests SET state = 'CLOSED' WHERE repository_id = ? AND state = 'OPEN' AND number NOT IN (${placeholders})`
      : "UPDATE pull_requests SET state = 'CLOSED' WHERE repository_id = ? AND state = 'OPEN'";
    return this.db.prepare(sql).run(repositoryId, ...presentNumbers).changes;
  }

  pullRequestsByState(repositoryIds: number[], state: string): PullRequestRecord[] {
    if (repositoryIds.length === 0) return [];
    const placeholders = repositoryIds.map(() => '?').join(', ');
    const where = state === 'ALL' ? '' : 'AND pr.state = ?';
    const params: unknown[] = [...repositoryIds];
    if (state !== 'ALL') params.push(state);

    const rows = this.db.prepare(`
      SELECT pr.*, r.name AS repository_name, r.slug AS repository_slug, r.integration_id
      FROM pull_requests pr
      JOIN repositories r ON r.id = pr.repository_id
      WHERE pr.repository_id IN (${placeholders}) ${where}
      ORDER BY pr.created_at ASC
    `).all(...params) as Record<string, never>[];

    const commits = this.db.prepare(
      'SELECT sha, message, author, committed_at FROM pull_request_commits WHERE pull_request_id = ? ORDER BY position',
    );
    const reviewers = this.db.prepare(
      'SELECT user_name, display_name, state, updated_at FROM pull_request_reviewers WHERE pull_request_id = ? ORDER BY user_name',
    );

    return rows.map((row) => {
      const r = row as unknown as Record<string, string & number & null>;
      return {
        id: Number(r.id),
        repositoryName: String(r.repository_name),
        repositorySlug: String(r.repository_slug),
        integrationId: String(r.integration_id),
        number: Number(r.number),
        title: String(r.title),
        description: r.description ?? null,
        state: String(r.state),
        author: String(r.author),
        authorDisplay: r.author_display ?? null,
        sourceBranch: String(r.source_branch),
        destinationBranch: String(r.destination_branch),
        url: r.url ?? null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        firstReviewAt: r.first_review_at ?? null,
        filesChanged: Number(r.files_changed),
        linesAdded: Number(r.lines_added),
        linesRemoved: Number(r.lines_removed),
        commentCount: Number(r.comment_count),
        unresolvedCount: Number(r.unresolved_count),
        commits: (commits.all(Number(r.id)) as Record<string, string | null>[]).map((c) => ({
          sha: String(c.sha), message: String(c.message),
          author: c.author ?? null, committedAt: c.committed_at ?? null,
        })),
        reviewers: (reviewers.all(Number(r.id)) as Record<string, string | null>[]).map((v) => ({
          userName: String(v.user_name), displayName: v.display_name ?? null,
          state: String(v.state) as ReviewerInput['state'], updatedAt: v.updated_at ?? null,
        })),
      } satisfies PullRequestRecord;
    });
  }

  // --- pipelines -----------------------------------------------------------

  upsertPipeline(input: PipelineInput, steps: StepInput[]): number {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO pipelines (
          repository_id, number, name, branch, commit_sha, triggered_by, trigger_type,
          outcome, url, created_at, completed_at, duration_ms
        ) VALUES (
          @repositoryId, @number, @name, @branch, @commitSha, @triggeredBy, @triggerType,
          @outcome, @url, @createdAt, @completedAt, @durationMs
        )
        ON CONFLICT (repository_id, number) DO UPDATE SET
          name = excluded.name, branch = excluded.branch, commit_sha = excluded.commit_sha,
          triggered_by = excluded.triggered_by, trigger_type = excluded.trigger_type,
          outcome = excluded.outcome, url = excluded.url,
          completed_at = excluded.completed_at, duration_ms = excluded.duration_ms
      `).run(input as unknown as Record<string, unknown>);

      const row = this.db.prepare('SELECT id FROM pipelines WHERE repository_id = ? AND number = ?')
        .get(input.repositoryId, input.number) as { id: number };

      this.db.prepare('DELETE FROM pipeline_steps WHERE pipeline_id = ?').run(row.id);
      const insert = this.db.prepare(
        'INSERT INTO pipeline_steps (pipeline_id, position, name, outcome, duration_ms) VALUES (?, ?, ?, ?, ?)',
      );
      steps.forEach((s, i) => insert.run(row.id, i, s.name, s.outcome, s.durationMs));
      return row.id;
    });
  }

  pipelinesSince(repositoryIds: number[], since: string, limit: number): PipelineRecord[] {
    if (repositoryIds.length === 0) return [];
    const placeholders = repositoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT p.*, r.name AS repository_name, r.slug AS repository_slug, r.integration_id
      FROM pipelines p
      JOIN repositories r ON r.id = p.repository_id
      WHERE p.repository_id IN (${placeholders}) AND p.created_at >= ?
      ORDER BY p.created_at DESC
      LIMIT ?
    `).all(...repositoryIds, since, limit) as Record<string, never>[];

    const steps = this.db.prepare(
      'SELECT name, outcome, duration_ms FROM pipeline_steps WHERE pipeline_id = ? ORDER BY position',
    );

    return rows.map((row) => {
      const r = row as unknown as Record<string, string & number & null>;
      return {
        id: Number(r.id),
        repositoryName: String(r.repository_name),
        repositorySlug: String(r.repository_slug),
        integrationId: String(r.integration_id),
        number: Number(r.number),
        name: String(r.name),
        branch: String(r.branch),
        commitSha: r.commit_sha ?? null,
        triggeredBy: String(r.triggered_by),
        triggerType: r.trigger_type ?? null,
        outcome: String(r.outcome),
        url: r.url ?? null,
        createdAt: String(r.created_at),
        completedAt: r.completed_at ?? null,
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        steps: (steps.all(Number(r.id)) as Record<string, string | number>[]).map((s) => ({
          name: String(s.name),
          outcome: String(s.outcome) as StepInput['outcome'],
          durationMs: Number(s.duration_ms),
        })),
      } satisfies PipelineRecord;
    });
  }

  /** Aggregates for the CICD headline, over every pipeline in the window. */
  pipelineStats(repositoryIds: number[], since: string): {
    total: number; passed: number; failed: number; stopped: number; running: number; durations: number[];
  } {
    const empty = { total: 0, passed: 0, failed: 0, stopped: 0, running: 0, durations: [] as number[] };
    if (repositoryIds.length === 0) return empty;
    const placeholders = repositoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT outcome, duration_ms FROM pipelines WHERE repository_id IN (${placeholders}) AND created_at >= ?`,
    ).all(...repositoryIds, since) as { outcome: string; duration_ms: number | null }[];

    const stats = { ...empty, durations: [] as number[] };
    for (const row of rows) {
      stats.total += 1;
      if (row.outcome === 'PASSED') stats.passed += 1;
      else if (row.outcome === 'FAILED') stats.failed += 1;
      else if (row.outcome === 'STOPPED') stats.stopped += 1;
      else stats.running += 1;
      if (row.duration_ms) stats.durations.push(row.duration_ms);
    }
    return stats;
  }

  // --- Jira ----------------------------------------------------------------

  upsertJiraIssue(input: JiraIssueInput): number {
    this.db.prepare(`
      INSERT INTO jira_issues (
        integration_id, issue_key, issue_type, title, description, status, status_category,
        assignee, reporter, url, created_at, updated_at, resolved_at
      ) VALUES (
        @integrationId, @key, @type, @title, @description, @status, @statusCategory,
        @assignee, @reporter, @url, @createdAt, @updatedAt, @resolvedAt
      )
      ON CONFLICT (integration_id, issue_key) DO UPDATE SET
        issue_type = excluded.issue_type, title = excluded.title, description = excluded.description,
        status = excluded.status, status_category = excluded.status_category,
        assignee = excluded.assignee, reporter = excluded.reporter, url = excluded.url,
        updated_at = excluded.updated_at, resolved_at = excluded.resolved_at
    `).run(input as unknown as Record<string, unknown>);
    const row = this.db.prepare('SELECT id FROM jira_issues WHERE integration_id = ? AND issue_key = ?')
      .get(input.integrationId, input.key) as { id: number };
    return row.id;
  }

  /** True when the stored changelog predates the issue's latest change. */
  needsChangelog(issueId: number, updatedAt: string): boolean {
    const row = this.db.prepare('SELECT changelog_at FROM jira_issues WHERE id = ?')
      .get(issueId) as { changelog_at: string | null } | undefined;
    const fetched = row?.changelog_at;
    return !fetched || fetched < updatedAt;
  }

  saveIssueChanges(issueId: number, changes: IssueChangeInput[], fetchedAt: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM jira_issue_changes WHERE issue_id = ?').run(issueId);
      const insert = this.db.prepare(
        'INSERT INTO jira_issue_changes (issue_id, position, field, from_value, to_value, changed_at, author) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      changes.forEach((c, i) => insert.run(issueId, i, c.field, c.fromValue, c.toValue, c.changedAt, c.author));
      this.db.prepare('UPDATE jira_issues SET changelog_at = ? WHERE id = ?').run(fetchedAt, issueId);
    });
  }

  recordSummaryMembers(runId: number, summarySlug: string, issueIds: number[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM jira_summary_members WHERE run_id = ? AND summary_slug = ?')
        .run(runId, summarySlug);
      const insert = this.db.prepare(
        'INSERT INTO jira_summary_members (run_id, summary_slug, issue_id, position) VALUES (?, ?, ?, ?)',
      );
      issueIds.forEach((id, i) => insert.run(runId, summarySlug, id, i));
    });
  }

  summaryCount(runId: number, summarySlug: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM jira_summary_members WHERE run_id = ? AND summary_slug = ?',
    ).get(runId, summarySlug) as { n: number };
    return row.n;
  }

  issuesForSummary(runId: number, summarySlug: string): JiraIssueRecord[] {
    const rows = this.db.prepare(`
      SELECT i.* FROM jira_summary_members m
      JOIN jira_issues i ON i.id = m.issue_id
      WHERE m.run_id = ? AND m.summary_slug = ?
      ORDER BY m.position
    `).all(runId, summarySlug) as Record<string, never>[];

    const changes = this.db.prepare(
      'SELECT field, from_value, to_value, changed_at, author FROM jira_issue_changes WHERE issue_id = ? ORDER BY position',
    );

    return rows.map((row) => {
      const r = row as unknown as Record<string, string & number & null>;
      return {
        id: Number(r.id),
        integrationId: String(r.integration_id),
        key: String(r.issue_key),
        type: String(r.issue_type),
        title: String(r.title),
        description: r.description ?? null,
        status: String(r.status),
        statusCategory: r.status_category ?? null,
        assignee: r.assignee ?? null,
        reporter: r.reporter ?? null,
        url: r.url ?? null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        resolvedAt: r.resolved_at ?? null,
        changes: (changes.all(Number(r.id)) as Record<string, string | null>[]).map((c) => ({
          field: String(c.field) as IssueChangeInput['field'],
          fromValue: c.from_value ?? null,
          toValue: c.to_value ?? null,
          changedAt: String(c.changed_at),
          author: c.author ?? null,
        })),
      } satisfies JiraIssueRecord;
    });
  }
}
