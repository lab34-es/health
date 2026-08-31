import { HttpClient } from './http.js';
import { HealthError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { IntegrationConfig } from '../config/types.js';
import type {
  CommitInput, PipelineInput, PullRequestDetail, PullRequestInput, ReviewerInput, StepInput,
} from '../db/types.js';

const DEFAULT_BASE = 'https://api.bitbucket.org/2.0';
const PAGE_SIZE = 50;

interface Page<T> { values?: T[]; next?: string }

interface BbUser { nickname?: string; display_name?: string; account_id?: string }
interface BbPullRequest {
  id: number; title: string; description?: string; state: string;
  author?: BbUser; source?: { branch?: { name?: string } }; destination?: { branch?: { name?: string } };
  links?: { html?: { href?: string } };
  created_on: string; updated_on: string; closed_on?: string | null;
  comment_count?: number; task_count?: number;
  participants?: { user?: BbUser; state?: string | null; approved?: boolean; participated_on?: string | null }[];
  reviewers?: BbUser[];
}

function userName(user: BbUser | undefined): string {
  return user?.nickname ?? user?.display_name ?? user?.account_id ?? 'unknown';
}

/** Bitbucket sends "+00:00" offsets; normalise to a comparable ISO string. */
function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface PullRequestSummary {
  input: Omit<PullRequestInput, 'repositoryId'>;
  updatedAt: string;
}

export interface PullRequestDetailResult {
  detail: PullRequestDetail;
  commits: CommitInput[];
  reviewers: ReviewerInput[];
}

export interface PipelineResult {
  input: Omit<PipelineInput, 'repositoryId'>;
  steps: StepInput[];
}

export class BitbucketClient {
  private readonly http: HttpClient;
  readonly workspace: string;

  constructor(private readonly integration: IntegrationConfig, logger: Logger) {
    if (!integration.workspace) {
      throw new HealthError(`integration "${integration.id}" is missing a workspace`);
    }
    this.workspace = integration.workspace;
    this.http = new HttpClient(integration, integration.baseUrl ?? DEFAULT_BASE, logger);
  }

  get id(): string { return this.integration.id; }

  /** Follows Bitbucket's `next` links, stopping when `stop` says to. */
  private async paginate<T>(
    path: string, query: Record<string, string | number | undefined>,
    stop?: (item: T) => boolean,
  ): Promise<T[]> {
    const out: T[] = [];
    let page = await this.http.json<Page<T>>(path, { query });

    for (;;) {
      for (const item of page.values ?? []) {
        if (stop?.(item)) return out;
        out.push(item);
      }
      if (!page.next) return out;
      page = await this.http.json<Page<T>>(page.next);
    }
  }

  /**
   * Lists pull requests in the given state.
   *
   * The listing is always fetched in full rather than filtered by update time:
   * it is one cheap call per repository, and it is the only way to learn that a
   * pull request we hold as open has since been merged. The expensive per-pull-request
   * detail is what gets skipped for unchanged items, in `pullRequestDetail`.
   */
  async listPullRequests(slug: string, state: string): Promise<PullRequestSummary[]> {
    const query: Record<string, string | number> = { pagelen: PAGE_SIZE, sort: '-updated_on' };
    if (state !== 'ALL') query.state = state;

    const values = await this.paginate<BbPullRequest>(
      `/repositories/${this.workspace}/${slug}/pullrequests`, query,
    );

    return values.map((pr) => {
      const updatedAt = iso(pr.updated_on) ?? iso(pr.created_on) ?? new Date().toISOString();
      return {
        updatedAt,
        input: {
          number: pr.id,
          title: pr.title,
          description: pr.description ?? null,
          state: pr.state,
          author: userName(pr.author),
          authorDisplay: pr.author?.display_name ?? null,
          sourceBranch: pr.source?.branch?.name ?? '(unknown)',
          destinationBranch: pr.destination?.branch?.name ?? '(unknown)',
          url: pr.links?.html?.href ?? null,
          createdAt: iso(pr.created_on) ?? updatedAt,
          updatedAt,
          closedAt: iso(pr.closed_on),
          mergedAt: pr.state === 'MERGED' ? iso(pr.closed_on) : null,
        },
      };
    });
  }

  /** Detail, diffstat, commits and review state for one pull request. */
  async pullRequestDetail(slug: string, number: number): Promise<PullRequestDetailResult> {
    const base = `/repositories/${this.workspace}/${slug}/pullrequests/${number}`;

    const [detail, diffstat, commits, activity] = await Promise.all([
      this.http.json<BbPullRequest>(base),
      this.paginate<{ lines_added?: number; lines_removed?: number }>(`${base}/diffstat`, { pagelen: 100 }),
      this.paginate<{ hash: string; message?: string; date?: string; author?: { raw?: string; user?: BbUser } }>(
        `${base}/commits`, { pagelen: 100 },
      ),
      this.paginate<Record<string, unknown>>(`${base}/activity`, { pagelen: 50 }).catch(() => []),
    ]);

    let filesChanged = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const file of diffstat) {
      filesChanged += 1;
      linesAdded += file.lines_added ?? 0;
      linesRemoved += file.lines_removed ?? 0;
    }

    return {
      detail: {
        firstReviewAt: firstReviewFrom(activity),
        filesChanged,
        linesAdded,
        linesRemoved,
        commentCount: detail.comment_count ?? 0,
        // Bitbucket models unresolved review threads as open tasks.
        unresolvedCount: detail.task_count ?? 0,
      },
      // Bitbucket lists commits newest first; the report reads oldest first.
      commits: commits.reverse().map((c) => ({
        sha: c.hash.slice(0, 7),
        message: (c.message ?? '').split('\n')[0]?.trim() ?? '',
        author: c.author?.user ? userName(c.author.user) : (c.author?.raw ?? null),
        committedAt: iso(c.date),
      })),
      reviewers: reviewersFrom(detail),
    };
  }

  /** Pipelines started at or after `since`, newest first. */
  async listPipelines(slug: string, since: string, limit: number): Promise<PipelineResult[]> {
    const raw = await this.paginate<Record<string, never>>(
      `/repositories/${this.workspace}/${slug}/pipelines`,
      { pagelen: PAGE_SIZE, sort: '-created_on' },
      // Sorted newest first, so the first pipeline older than the window ends
      // the walk rather than paging through the repository's whole history.
      (item) => {
        const created = iso((item as Record<string, string>).created_on);
        return created !== null && created < since;
      },
    );

    const results: PipelineResult[] = [];
    for (const item of raw.slice(0, limit)) {
      const pipeline = item as unknown as {
        uuid: string; build_number: number;
        state?: { name?: string; result?: { name?: string } };
        creator?: BbUser;
        target?: { ref_name?: string; commit?: { hash?: string }; selector?: { type?: string; pattern?: string } };
        trigger?: { name?: string };
        created_on: string; completed_on?: string | null; duration_in_seconds?: number;
      };

      const createdAt = iso(pipeline.created_on);
      if (!createdAt) continue;

      const steps = await this.pipelineSteps(slug, pipeline.uuid).catch(() => [] as StepInput[]);

      results.push({
        steps,
        input: {
          number: pipeline.build_number,
          name: pipeline.target?.selector?.pattern ?? pipeline.target?.selector?.type ?? 'default',
          branch: pipeline.target?.ref_name ?? '(unknown)',
          commitSha: pipeline.target?.commit?.hash?.slice(0, 7) ?? null,
          triggeredBy: userName(pipeline.creator),
          triggerType: pipeline.trigger?.name?.toLowerCase() ?? null,
          outcome: pipelineOutcome(pipeline.state),
          url: `https://bitbucket.org/${this.workspace}/${slug}/pipelines/results/${pipeline.build_number}`,
          createdAt,
          completedAt: iso(pipeline.completed_on),
          durationMs: pipeline.duration_in_seconds ? pipeline.duration_in_seconds * 1000 : null,
        },
      });
    }
    return results;
  }

  private async pipelineSteps(slug: string, uuid: string): Promise<StepInput[]> {
    const values = await this.paginate<{
      name?: string; state?: { name?: string; result?: { name?: string } }; duration_in_seconds?: number;
    }>(`/repositories/${this.workspace}/${slug}/pipelines/${encodeURIComponent(uuid)}/steps/`, { pagelen: 100 });

    return values.map((step, index) => ({
      name: step.name ?? `step ${index + 1}`,
      outcome: stepOutcome(step.state),
      durationMs: (step.duration_in_seconds ?? 0) * 1000,
    }));
  }
}

export function pipelineOutcome(state: { name?: string; result?: { name?: string } } | undefined): string {
  const result = state?.result?.name?.toUpperCase();
  if (result === 'SUCCESSFUL') return 'PASSED';
  if (result === 'FAILED' || result === 'ERROR') return 'FAILED';
  if (result === 'STOPPED') return 'STOPPED';
  const name = state?.name?.toUpperCase();
  if (name === 'IN_PROGRESS' || name === 'PENDING') return 'RUNNING';
  return name === 'COMPLETED' ? 'PASSED' : 'RUNNING';
}

export function stepOutcome(state: { name?: string; result?: { name?: string } } | undefined): StepInput['outcome'] {
  const result = state?.result?.name?.toUpperCase();
  if (result === 'SUCCESSFUL') return 'passed';
  if (result === 'FAILED' || result === 'ERROR') return 'failed';
  // A stopped step never ran to completion; the report groups it with skipped
  // rather than claiming a failure the team did not cause.
  if (result === 'STOPPED' || result === 'SKIPPED') return 'skipped';
  const name = state?.name?.toUpperCase();
  if (name === 'IN_PROGRESS') return 'running';
  if (name === 'PENDING' || name === 'NOT_RUN' || name === 'READY') return 'skipped';
  return 'skipped';
}

/** Earliest approval, change request or review comment on a pull request. */
export function firstReviewFrom(activity: Record<string, unknown>[]): string | null {
  let earliest: string | null = null;

  for (const entry of activity) {
    const candidates = [
      (entry.approval as { date?: string } | undefined)?.date,
      (entry.changes_requested as { date?: string } | undefined)?.date,
      (entry.comment as { created_on?: string } | undefined)?.created_on,
    ];
    for (const candidate of candidates) {
      const at = iso(candidate);
      if (at && (earliest === null || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

/** Per-reviewer state, including reviewers who have not responded yet. */
export function reviewersFrom(detail: BbPullRequest): ReviewerInput[] {
  const byName = new Map<string, ReviewerInput>();

  for (const reviewer of detail.reviewers ?? []) {
    byName.set(userName(reviewer), {
      userName: userName(reviewer), displayName: reviewer.display_name ?? null,
      state: 'pending', updatedAt: null,
    });
  }

  for (const participant of detail.participants ?? []) {
    if (!participant.user) continue;
    const name = userName(participant.user);
    const raw = participant.state?.toLowerCase();
    const state: ReviewerInput['state'] = raw === 'approved' || participant.approved === true
      ? 'approved'
      : raw === 'changes_requested' ? 'changes_requested' : 'pending';

    // Participants include the author and anyone who commented; only surface
    // people the pull request is actually waiting on or has heard from.
    if (state === 'pending' && !byName.has(name)) continue;

    byName.set(name, {
      userName: name, displayName: participant.user.display_name ?? null,
      state, updatedAt: iso(participant.participated_on),
    });
  }

  return [...byName.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}
