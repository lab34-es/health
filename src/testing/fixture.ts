import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { IssueChangeInput } from '../db/types.js';

/**
 * Seeds a database with a worked example of a team's week.
 *
 * Used by the end-to-end test and by `npm run example` to regenerate the
 * shipped example report. Generating the example rather than hand-writing it
 * means docs/formats.md can never describe a document the tool does not emit.
 */

const HISTORY: Record<string, number[]> = {
  'pull_requests.open': [9, 11, 10, 8, 7, 6, 6],
  'pull_requests.avg_age_hours': [44, 41, 39, 42, 40, 39, 41],
  'pull_requests.over_threshold': [6, 5, 5, 4, 4, 3, 3],
  'pull_requests.review_turnaround_hours': [22, 21, 19, 18, 17, 16, 15],
  'pipelines.total': [14, 15, 13, 16, 14, 12, 11],
  'pipelines.success_rate': [78, 80, 79, 83, 82, 71, 69],
  'pipelines.median_duration_seconds': [600, 580, 560, 520, 480, 430, 400],
  'jira.open_total': [4, 5, 5, 6, 6, 7, 6],
  'jira.summary.tech-debt-cloud.count': [1, 2, 2, 3, 3, 3, 3],
  'jira.summary.tech-debt-physical.count': [1, 1, 1, 1, 2, 2, 1],
  'jira.summary.tech-debt-infra.count': [2, 2, 2, 2, 1, 2, 2],
};

const FIRST_RUN = 475;

interface PrSeed {
  repo: string; number: number; title: string; author: string; authorDisplay: string;
  source: string; destination: string; createdAt: string;
  files: number; added: number; removed: number; comments: number; unresolved: number;
  firstReviewAt: string | null;
  reviewers: [string, 'approved' | 'changes_requested' | 'pending', string | null][];
  commits: [string, string, string][];
}

const PULL_REQUESTS: PrSeed[] = [
  {
    repo: 'project_backend', number: 412, title: 'Parcel dedup on intake queue',
    author: 'a.ruiz', authorDisplay: 'Ana Ruiz',
    source: 'feature/intake-dedup', destination: 'develop', createdAt: '2026-08-17T10:14:02Z',
    files: 18, added: 512, removed: 130, comments: 11, unresolved: 2,
    firstReviewAt: '2026-08-18T08:02:00Z',
    reviewers: [
      ['m.dupont', 'approved', '2026-08-18T08:02:00Z'],
      ['s.peeters', 'changes_requested', '2026-08-19T09:41:00Z'],
    ],
    commits: [
      ['9f2c1ab', 'add dedup index on tracking_id', '2026-08-17T10:20:00Z'],
      ['4b81de0', 'guard against null carrier code', '2026-08-18T07:55:00Z'],
      ['c07aa39', 'unit tests for dedup window', '2026-08-18T13:10:00Z'],
      ['e19b4f5', 'address review: extract policy class', '2026-08-19T14:20:00Z'],
    ],
  },
  {
    repo: 'project_frontend', number: 288, title: 'Shipment detail: status timeline',
    author: 'l.martens', authorDisplay: 'Lore Martens',
    source: 'feature/status-timeline', destination: 'develop', createdAt: '2026-08-18T05:14:02Z',
    files: 24, added: 801, removed: 117, comments: 4, unresolved: 0, firstReviewAt: null,
    reviewers: [['a.ruiz', 'pending', null]],
    commits: [
      ['7d3e991', 'timeline component scaffold', '2026-08-18T05:20:00Z'],
      ['b2f0c14', 'wire status history endpoint', '2026-08-18T11:44:00Z'],
      ['5ac6207', 'responsive lane collapse', '2026-08-19T16:02:00Z'],
    ],
  },
  {
    repo: 'project_backend', number: 415, title: 'Retry policy for carrier webhooks',
    author: 's.peeters', authorDisplay: 'Sam Peeters',
    source: 'fix/webhook-retry', destination: 'develop', createdAt: '2026-08-18T16:14:02Z',
    files: 7, added: 186, removed: 28, comments: 6, unresolved: 1,
    firstReviewAt: '2026-08-19T08:15:00Z',
    reviewers: [['a.ruiz', 'approved', '2026-08-19T08:15:00Z'], ['j.claes', 'pending', null]],
    commits: [
      ['1c9df70', 'exponential backoff with jitter', '2026-08-18T16:20:00Z'],
      ['a8e2b31', 'cap retries at 6 attempts', '2026-08-19T18:30:00Z'],
    ],
  },
  {
    repo: 'project_infra', number: 97, title: 'Split staging pipeline into two stages',
    author: 'j.claes', authorDisplay: 'Jonas Claes',
    source: 'chore/pipeline-split', destination: 'main', createdAt: '2026-08-19T14:14:02Z',
    files: 4, added: 82, removed: 14, comments: 2, unresolved: 0,
    firstReviewAt: '2026-08-19T17:05:00Z',
    reviewers: [['m.dupont', 'approved', '2026-08-19T17:05:00Z']],
    commits: [
      ['3fa0c58', 'extract build stage', '2026-08-19T14:14:00Z'],
      ['9b17e4c', 'cache node_modules between stages', '2026-08-19T15:30:00Z'],
    ],
  },
  {
    repo: 'project_frontend', number: 291, title: 'Fix locale fallback on tracking page',
    author: 'm.dupont', authorDisplay: 'Marie Dupont',
    source: 'fix/locale-fallback', destination: 'develop', createdAt: '2026-08-20T03:14:02Z',
    files: 3, added: 39, removed: 8, comments: 0, unresolved: 0, firstReviewAt: null,
    reviewers: [['l.martens', 'pending', null]],
    commits: [['62c4d18', 'fallback to nl-BE when locale missing', '2026-08-20T03:20:00Z']],
  },
];

type StepSeed = [string, 'passed' | 'failed' | 'skipped', number];

interface PipelineSeed {
  repo: string; number: number; name: string; branch: string; commit: string;
  by: string; trigger: string; createdAt: string; seconds: number; outcome: string;
  steps: StepSeed[];
}

const PIPELINES: PipelineSeed[] = [
  {
    repo: 'project_backend', number: 5521, name: 'backend · build & deploy', branch: 'develop',
    commit: 'a71ce09', by: 'a.ruiz', trigger: 'push', createdAt: '2026-08-20T07:14:02Z',
    seconds: 700, outcome: 'FAILED',
    steps: [['install', 'passed', 48], ['lint', 'passed', 61], ['unit-tests', 'passed', 274],
      ['integration-tests', 'failed', 317], ['package', 'skipped', 0], ['deploy-staging', 'skipped', 0]],
  },
  {
    repo: 'project_backend', number: 5520, name: 'backend · build & deploy', branch: 'feature/intake-dedup',
    commit: 'e19b4f5', by: 's.peeters', trigger: 'push', createdAt: '2026-08-20T04:14:02Z',
    seconds: 542, outcome: 'PASSED',
    steps: [['install', 'passed', 44], ['lint', 'passed', 55], ['unit-tests', 'passed', 208],
      ['integration-tests', 'passed', 149], ['package', 'passed', 51], ['deploy-staging', 'passed', 35]],
  },
  {
    repo: 'project_frontend', number: 3310, name: 'frontend · ci', branch: 'develop',
    commit: '5ac6207', by: 'l.martens', trigger: 'push', createdAt: '2026-08-20T03:14:02Z',
    seconds: 378, outcome: 'PASSED',
    steps: [['install', 'passed', 62], ['lint', 'passed', 40], ['unit-tests', 'passed', 151],
      ['build', 'passed', 125], ['visual-diff', 'skipped', 0]],
  },
  {
    repo: 'project_frontend', number: 3309, name: 'frontend · ci', branch: 'fix/locale-fallback',
    commit: '62c4d18', by: 'm.dupont', trigger: 'push', createdAt: '2026-08-20T02:14:02Z',
    seconds: 351, outcome: 'FAILED',
    steps: [['install', 'passed', 58], ['lint', 'failed', 293], ['unit-tests', 'skipped', 0],
      ['build', 'skipped', 0], ['visual-diff', 'skipped', 0]],
  },
  {
    repo: 'project_infra', number: 1204, name: 'infra · terraform plan', branch: 'main',
    commit: '9b17e4c', by: 'j.claes', trigger: 'push', createdAt: '2026-08-20T00:14:02Z',
    seconds: 207, outcome: 'PASSED',
    steps: [['init', 'passed', 21], ['validate', 'passed', 18], ['plan', 'passed', 132],
      ['policy-check', 'passed', 36]],
  },
  {
    repo: 'project_infra', number: 1203, name: 'infra · nightly drift', branch: 'main',
    commit: '3fa0c58', by: 'scheduler', trigger: 'schedule', createdAt: '2026-08-19T19:14:02Z',
    seconds: 124, outcome: 'PASSED',
    steps: [['init', 'passed', 19], ['refresh', 'passed', 71], ['drift-report', 'passed', 34]],
  },
];

interface IssueSeed {
  summary: string; key: string; type: string; title: string; description: string;
  status: string; category: string; assignee: string | null; reporter: string;
  createdAt: string; updatedAt: string; resolvedAt: string | null;
  statuses: [string, string][];
  assignees: [string | null, string][];
}

const ISSUES: IssueSeed[] = [
  {
    summary: 'tech-debt-cloud', key: 'PROJECT-1841', type: 'Debt',
    title: 'Replace deprecated S3 SDK v2 calls',
    description: 'The storage adapter still uses SDK v2 clients, which no longer receive security patches. Migration touches parcel-label rendering and the archive export job.',
    status: 'Code Review', category: 'in_progress', assignee: 'm.dupont', reporter: 'a.ruiz',
    createdAt: '2026-08-08T09:14:02Z', updatedAt: '2026-08-16T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-08-08T09:14:02Z'], ['In Progress', '2026-08-11T09:14:02Z'], ['Code Review', '2026-08-16T09:14:02Z']],
    assignees: [['a.ruiz', '2026-08-11T09:14:02Z'], ['m.dupont', '2026-08-16T09:14:02Z']],
  },
  {
    summary: 'tech-debt-cloud', key: 'PROJECT-1907', type: 'Debt',
    title: 'Consolidate three logging formats into one',
    description: 'Backend, worker and infra emit different log shapes, so a single request cannot be followed across services. Target is one structured JSON envelope.',
    status: 'In Progress', category: 'in_progress', assignee: 'j.claes', reporter: 'a.ruiz',
    createdAt: '2026-08-12T09:14:02Z', updatedAt: '2026-08-16T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-08-12T09:14:02Z'], ['In Progress', '2026-08-16T09:14:02Z']],
    assignees: [['j.claes', '2026-08-16T09:14:02Z']],
  },
  {
    summary: 'tech-debt-cloud', key: 'PROJECT-1788', type: 'Bug',
    title: 'Intake worker leaks DB connections under retry',
    description: 'Connections are not returned to the pool when a carrier webhook retries within the same transaction window, exhausting the pool after roughly six hours of load.',
    status: 'QA', category: 'in_progress', assignee: 'l.martens', reporter: 's.peeters',
    createdAt: '2026-07-30T09:14:02Z', updatedAt: '2026-08-15T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-07-30T09:14:02Z'], ['In Progress', '2026-08-05T09:14:02Z'],
      ['Code Review', '2026-08-12T09:14:02Z'], ['QA', '2026-08-15T09:14:02Z']],
    assignees: [['s.peeters', '2026-08-05T09:14:02Z'], ['a.ruiz', '2026-08-12T09:14:02Z'], ['l.martens', '2026-08-15T09:14:02Z']],
  },
  {
    summary: 'tech-debt-physical', key: 'PROJECT-1655', type: 'Debt',
    title: 'Scanner firmware compatibility matrix untested',
    description: 'Three depot scanner models run firmware the pipeline never exercises, so label parsing regressions only surface on site.',
    status: 'To Do', category: 'to_do', assignee: null, reporter: 'j.claes',
    createdAt: '2026-07-17T09:14:02Z', updatedAt: '2026-07-17T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-07-17T09:14:02Z']],
    assignees: [],
  },
  {
    summary: 'tech-debt-physical', key: 'PROJECT-1902', type: 'Task',
    title: 'Extract sorting-belt adapter from monolith',
    description: 'The belt controller protocol is embedded in the intake service, which blocks independent deploys of the depot integration.',
    status: 'In Progress', category: 'in_progress', assignee: 'm.dupont', reporter: 'j.claes',
    createdAt: '2026-08-11T09:14:02Z', updatedAt: '2026-08-13T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-08-11T09:14:02Z'], ['In Progress', '2026-08-13T09:14:02Z']],
    assignees: [['m.dupont', '2026-08-13T09:14:02Z']],
  },
  {
    summary: 'tech-debt-infra', key: 'PROJECT-1873', type: 'Debt',
    title: 'Terraform state split per environment',
    description: 'Staging and production share one state file, so any plan locks both environments and a mistaken apply can cross the boundary.',
    status: 'Code Review', category: 'in_progress', assignee: 's.peeters', reporter: 'j.claes',
    createdAt: '2026-08-05T09:14:02Z', updatedAt: '2026-08-15T09:14:02Z', resolvedAt: null,
    statuses: [['To Do', '2026-08-05T09:14:02Z'], ['In Progress', '2026-08-09T09:14:02Z'], ['Code Review', '2026-08-15T09:14:02Z']],
    assignees: [['j.claes', '2026-08-09T09:14:02Z'], ['s.peeters', '2026-08-15T09:14:02Z']],
  },
  {
    summary: 'tech-debt-infra', key: 'PROJECT-1931', type: 'Task',
    title: 'Pin base images and enable digest scanning',
    description: 'Base images were tracked by floating tags, making builds non-reproducible and hiding CVE drift between deploys.',
    status: 'Done', category: 'done', assignee: 'a.ruiz', reporter: 'j.claes',
    createdAt: '2026-08-13T09:14:02Z', updatedAt: '2026-08-18T09:14:02Z', resolvedAt: '2026-08-18T09:14:02Z',
    statuses: [['To Do', '2026-08-13T09:14:02Z'], ['In Progress', '2026-08-14T09:14:02Z'],
      ['Code Review', '2026-08-17T09:14:02Z'], ['Done', '2026-08-18T09:14:02Z']],
    assignees: [['a.ruiz', '2026-08-14T09:14:02Z'], ['j.claes', '2026-08-17T09:14:02Z']],
  },
];

const REPOSITORIES: [string, string][] = [
  ['project_backend', 'PROJECT Backend'],
  ['project_frontend', 'PROJECT Frontend'],
  ['project_infra', 'PROJECT Infra'],
];

export interface Fixture { runId: number; repositoryIds: number[] }

export function seedFixture(db: Db, store: Store, now: Date): Fixture {
  const bitbucket = 'bitbucket_acme';
  const jira = 'jira_ACMEintl';

  // Explicit run ids so the example reads like a team's 482nd Monday rather
  // than its first.
  const insertRun = db.prepare(
    "INSERT INTO runs (id, report_id, started_at, finished_at, status, duration_ms) VALUES (?, ?, ?, ?, 'ok', ?)",
  );
  for (let i = 0; i < 7; i += 1) {
    const number = FIRST_RUN + i;
    const at = new Date(now.getTime() - (7 - i) * 86_400_000).toISOString();
    insertRun.run(number, `run-${number}`, at, at, 190_000);
    for (const [metric, values] of Object.entries(HISTORY)) {
      store.setMetric(number, metric, values[i] as number);
    }
  }

  const runId = store.beginRun('2026-08-20T09-14-02Z', now.toISOString());

  const repositoryIds = REPOSITORIES.map(([slug, name]) => store.upsertRepository(bitbucket, slug, name));
  const idOf = (slug: string) => repositoryIds[REPOSITORIES.findIndex((r) => r[0] === slug)] as number;

  for (const pr of PULL_REQUESTS) {
    const id = store.upsertPullRequest({
      repositoryId: idOf(pr.repo), number: pr.number, title: pr.title, description: null,
      state: 'OPEN', author: pr.author, authorDisplay: pr.authorDisplay,
      sourceBranch: pr.source, destinationBranch: pr.destination,
      url: `https://bitbucket.org/ACMEintl/${pr.repo}/pull-requests/${pr.number}`,
      createdAt: pr.createdAt, updatedAt: pr.createdAt, closedAt: null, mergedAt: null,
    });
    store.savePullRequestDetail(id, {
      firstReviewAt: pr.firstReviewAt, filesChanged: pr.files, linesAdded: pr.added,
      linesRemoved: pr.removed, commentCount: pr.comments, unresolvedCount: pr.unresolved,
    },
    pr.commits.map(([sha, message, committedAt]) => ({ sha, message, author: pr.author, committedAt })),
    pr.reviewers.map(([userName, state, updatedAt]) => ({ userName, displayName: null, state, updatedAt })),
    now.toISOString());
  }

  for (const pipeline of PIPELINES) {
    store.upsertPipeline({
      repositoryId: idOf(pipeline.repo), number: pipeline.number, name: pipeline.name,
      branch: pipeline.branch, commitSha: pipeline.commit, triggeredBy: pipeline.by,
      triggerType: pipeline.trigger, outcome: pipeline.outcome,
      url: `https://bitbucket.org/ACMEintl/${pipeline.repo}/pipelines/results/${pipeline.number}`,
      createdAt: pipeline.createdAt,
      completedAt: new Date(new Date(pipeline.createdAt).getTime() + pipeline.seconds * 1000).toISOString(),
      durationMs: pipeline.seconds * 1000,
    }, pipeline.steps.map(([name, outcome, seconds]) => ({ name, outcome, durationMs: seconds * 1000 })));
  }

  const bySummary = new Map<string, number[]>();
  for (const issue of ISSUES) {
    const id = store.upsertJiraIssue({
      integrationId: jira, key: issue.key, type: issue.type, title: issue.title,
      description: issue.description, status: issue.status, statusCategory: issue.category,
      assignee: issue.assignee, reporter: issue.reporter,
      url: `https://ACMEintl.atlassian.net/browse/${issue.key}`,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt, resolvedAt: issue.resolvedAt,
    });

    // Shaped the way the Jira client emits it: the entry into the first status
    // is synthesised at creation time, since Jira records no transition for it.
    const changes: IssueChangeInput[] = [];
    issue.statuses.forEach(([status, at], index) => {
      changes.push({
        field: 'status',
        fromValue: index === 0 ? null : (issue.statuses[index - 1] as [string, string])[0],
        toValue: status, changedAt: at, author: null,
      });
    });
    issue.assignees.forEach(([who, at], index) => {
      changes.push({
        field: 'assignee',
        fromValue: index === 0 ? null : (issue.assignees[index - 1] as [string | null, string])[0],
        toValue: who, changedAt: at, author: null,
      });
    });
    changes.sort((a, b) => a.changedAt.localeCompare(b.changedAt));
    store.saveIssueChanges(id, changes, issue.updatedAt);

    const list = bySummary.get(issue.summary) ?? [];
    list.push(id);
    bySummary.set(issue.summary, list);
  }

  for (const [slug, ids] of bySummary) store.recordSummaryMembers(runId, slug, ids);

  return { runId, repositoryIds };
}
