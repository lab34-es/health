import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { openDatabase } from './index.js';
import { Store } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'lab34-health-db-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function freshStore(name: string): Store {
  return new Store(openDatabase(join(dir, `${name}.sql`)));
}

test('migrations are idempotent and create the schema', () => {
  const path = join(dir, 'migrate.sql');
  const first = openDatabase(path);
  const tables = first.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((r) => (r as { name: string }).name);
  first.close();

  assert.ok(tables.includes('pull_requests'));
  assert.ok(tables.includes('jira_issue_changes'));
  assert.ok(tables.includes('run_metrics'));

  // Reopening applies nothing further.
  const second = openDatabase(path);
  const applied = second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
  second.close();
  assert.equal(applied.n, 1);
});

test('metric series line up with the runs they are asked for', () => {
  const store = freshStore('metrics');
  const a = store.beginRun('r-a', '2026-08-18T09:00:00Z');
  const b = store.beginRun('r-b', '2026-08-19T09:00:00Z');
  const c = store.beginRun('r-c', '2026-08-20T09:00:00Z');

  store.setMetric(a, 'pull_requests.open', 9);
  store.setMetric(c, 'pull_requests.open', 14);

  // Run b never recorded the metric, so it reads back as a hole rather than
  // shortening the series and misaligning it with the runs axis.
  assert.deepEqual(store.metricSeries([a, b, c], 'pull_requests.open'), [9, null, 14]);
  assert.deepEqual(store.metricSeries([], 'pull_requests.open'), []);
});

test('pull request detail round-trips with commits and reviewers', () => {
  const store = freshStore('prs');
  const runId = store.beginRun('r', '2026-08-20T09:00:00Z');
  const repo = store.upsertRepository('bb', 'project_backend', 'PROJECT Backend');

  const prId = store.upsertPullRequest({
    repositoryId: repo, number: 412, title: 'Parcel dedup', description: null, state: 'OPEN',
    author: 'a.ruiz', authorDisplay: 'Ana Ruiz', sourceBranch: 'feature/x', destinationBranch: 'develop',
    url: null, createdAt: '2026-08-17T10:14:02Z', updatedAt: '2026-08-19T14:20:11Z',
    closedAt: null, mergedAt: null,
  });

  assert.equal(store.needsDetail(prId, '2026-08-19T14:20:11Z'), true);
  store.savePullRequestDetail(prId, {
    firstReviewAt: '2026-08-18T08:02:00Z', filesChanged: 18, linesAdded: 512,
    linesRemoved: 130, commentCount: 11, unresolvedCount: 2,
  }, [
    { sha: '9f2c1ab', message: 'add dedup index', author: 'a.ruiz', committedAt: '2026-08-17T10:20:00Z' },
    { sha: 'e19b4f5', message: 'address review', author: 'a.ruiz', committedAt: '2026-08-19T14:20:00Z' },
  ], [
    { userName: 'm.dupont', displayName: null, state: 'approved', updatedAt: '2026-08-18T08:02:00Z' },
    { userName: 's.peeters', displayName: null, state: 'changes_requested', updatedAt: '2026-08-19T09:41:00Z' },
  ], '2026-08-19T14:20:11Z');

  // Detail is now current, so a second run would not refetch it.
  assert.equal(store.needsDetail(prId, '2026-08-19T14:20:11Z'), false);
  assert.equal(store.needsDetail(prId, '2026-08-20T06:00:00Z'), true);

  const [pr] = store.pullRequestsByState([repo], 'OPEN');
  assert.equal(pr?.title, 'Parcel dedup');
  assert.equal(pr?.repositoryName, 'PROJECT Backend');
  assert.equal(pr?.filesChanged, 18);
  assert.deepEqual(pr?.commits.map((c) => c.sha), ['9f2c1ab', 'e19b4f5']);
  assert.equal(pr?.reviewers.length, 2);

  // A re-sync replaces rather than merges: the force-pushed commit is gone.
  store.savePullRequestDetail(prId, {
    firstReviewAt: null, filesChanged: 1, linesAdded: 1, linesRemoved: 0,
    commentCount: 0, unresolvedCount: 0,
  }, [{ sha: 'aaaa111', message: 'squashed', author: 'a.ruiz', committedAt: null }], [], '2026-08-20T06:00:00Z');
  const [after] = store.pullRequestsByState([repo], 'OPEN');
  assert.deepEqual(after?.commits.map((c) => c.sha), ['aaaa111']);
  assert.equal(after?.reviewers.length, 0);

  store.setMetric(runId, 'x', 1);
});

test('a pull request missing from a full listing stops being open', () => {
  const store = freshStore('closing');
  const repo = store.upsertRepository('bb', 'r', 'R');
  for (const number of [1, 2, 3]) {
    store.upsertPullRequest({
      repositoryId: repo, number, title: `pr ${number}`, description: null, state: 'OPEN',
      author: 'a', authorDisplay: null, sourceBranch: 's', destinationBranch: 'd', url: null,
      createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', closedAt: null, mergedAt: null,
    });
  }
  assert.equal(store.closeMissingOpenPullRequests(repo, [1, 3]), 1);
  assert.deepEqual(store.pullRequestsByState([repo], 'OPEN').map((p) => p.number), [1, 3]);
});

test('jira issues keep their changelog and per-run summary membership', () => {
  const store = freshStore('jira');
  const runId = store.beginRun('r', '2026-08-20T09:00:00Z');

  const issueId = store.upsertJiraIssue({
    integrationId: 'j', key: 'PROJECT-1841', type: 'DEBT', title: 'Replace SDK v2',
    description: 'body', status: 'Code Review', statusCategory: 'in_progress',
    assignee: 'a.ruiz', reporter: 'm.dupont', url: null,
    createdAt: '2026-08-08T09:14:02Z', updatedAt: '2026-08-16T09:14:02Z', resolvedAt: null,
  });

  assert.equal(store.needsChangelog(issueId, '2026-08-16T09:14:02Z'), true);
  store.saveIssueChanges(issueId, [
    { field: 'status', fromValue: null, toValue: 'To Do', changedAt: '2026-08-08T09:14:02Z', author: 'm.dupont' },
    { field: 'status', fromValue: 'To Do', toValue: 'In Progress', changedAt: '2026-08-11T09:14:02Z', author: 'a.ruiz' },
    { field: 'assignee', fromValue: null, toValue: 'a.ruiz', changedAt: '2026-08-11T09:14:02Z', author: 'a.ruiz' },
  ], '2026-08-16T09:14:02Z');
  assert.equal(store.needsChangelog(issueId, '2026-08-16T09:14:02Z'), false);

  store.recordSummaryMembers(runId, 'tech-debt-cloud', [issueId]);
  assert.equal(store.summaryCount(runId, 'tech-debt-cloud'), 1);

  const [issue] = store.issuesForSummary(runId, 'tech-debt-cloud');
  assert.equal(issue?.key, 'PROJECT-1841');
  assert.equal(issue?.changes.length, 3);
  assert.equal(issue?.changes[1]?.toValue, 'In Progress');
  assert.equal(issue?.changes[2]?.field, 'assignee');
});

test('pruning runs drops their metrics with them', () => {
  const store = freshStore('prune');
  const ids = ['a', 'b', 'c', 'd'].map((n) => store.beginRun(n, `2026-08-0${n.charCodeAt(0) - 96}T09:00:00Z`));
  for (const id of ids) store.setMetric(id, 'm', id);

  assert.equal(store.pruneRuns(2), 2);
  const kept = ids.slice(-2);
  assert.deepEqual(store.metricSeries(kept, 'm'), kept);
  assert.deepEqual(store.metricSeries(ids.slice(0, 2), 'm'), [null, null]);
});
