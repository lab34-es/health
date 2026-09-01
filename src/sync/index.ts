import { IntegrationRegistry } from '../integrations/registry.js';
import { HealthError, IntegrationError } from '../util/errors.js';
import { LAST_RUN_AT, type Store } from '../db/store.js';
import type { HealthConfig, RepositoryConfig } from '../config/types.js';
import type { Logger } from '../util/logger.js';

export interface SyncResult {
  /** Repository row ids, per section, in configured order. */
  pullRequestRepoIds: number[];
  cicdRepoIds: number[];
  /** Window start used for the CICD section. */
  cicdSince: string;
  /** How many items were actually fetched in detail this run. */
  stats: { pullRequestsSeen: number; pullRequestsFetched: number; pipelines: number; issuesSeen: number; issuesFetched: number };
  warnings: string[];
}

function scopeKey(...parts: string[]): string {
  return parts.join(':');
}

/**
 * Refused credentials end the run; everything else degrades to a warning.
 *
 * The tolerance below exists for outages — a source that is down now will
 * likely be back by the next run, so yesterday's data beats no report. A
 * credential that is refused is not an outage: it is a configuration error
 * that will still be there tomorrow, and degrading would leave the report
 * quietly stale behind a banner until somebody happened to read it. Failing
 * the run instead puts it in the exit code, where a schedule will see it.
 */
function abortOnRefusedCredentials(error: unknown): void {
  if (error instanceof IntegrationError && (error.status === 401 || error.status === 403)) {
    throw error;
  }
}

/**
 * Fetches everything the report needs into the database.
 *
 * A section that fails to sync records a warning and leaves its previously
 * stored data in place rather than aborting the run: a report built from
 * yesterday's Jira and today's Bitbucket is more useful than no report, as
 * long as it says so. Refused credentials are the exception — see
 * `abortOnRefusedCredentials`.
 */
export async function sync(
  config: HealthConfig, store: Store, runId: number, now: Date, logger: Logger,
): Promise<SyncResult> {
  const registry = new IntegrationRegistry(config, logger);
  const warnings: string[] = [];
  const stats = {
    pullRequestsSeen: 0, pullRequestsFetched: 0, pipelines: 0, issuesSeen: 0, issuesFetched: 0,
  };

  const lastRunAt = store.getLastRunAt();
  logger.debug(lastRunAt ? `last run at ${lastRunAt}` : 'no previous run — this is a first sync');

  const registerRepositories = (repositories: RepositoryConfig[]): number[] =>
    repositories.map((repo) => store.upsertRepository(repo.integration, repo.slug, repo.name));

  const pullRequestRepoIds = config.pullRequests
    ? registerRepositories(config.pullRequests.repositories) : [];
  const cicdRepoIds = config.cicd ? registerRepositories(config.cicd.repositories) : [];
  const cicdSince = new Date(now.getTime() - (config.cicd?.windowHours ?? 24) * 3_600_000).toISOString();

  // --- pull requests -------------------------------------------------------
  if (config.pullRequests) {
    const { repositories, state } = config.pullRequests;
    for (const [index, repo] of repositories.entries()) {
      const repositoryId = pullRequestRepoIds[index] as number;
      try {
        const client = registry.bitbucketClient(repo.integration);
        logger.step(`pull requests · ${repo.name}`);

        const listed = await client.listPullRequests(repo.slug, state);
        stats.pullRequestsSeen += listed.length;

        for (const summary of listed) {
          const pullRequestId = store.upsertPullRequest({ ...summary.input, repositoryId });

          // The listing is cheap and always runs; the detail behind it is not,
          // so it is fetched only when the pull request has actually moved.
          if (!store.needsDetail(pullRequestId, summary.updatedAt)) continue;

          const detail = await client.pullRequestDetail(repo.slug, summary.input.number);
          store.savePullRequestDetail(
            pullRequestId, detail.detail, detail.commits, detail.reviewers, summary.updatedAt,
          );
          stats.pullRequestsFetched += 1;
        }

        if (state === 'OPEN') {
          const closed = store.closeMissingOpenPullRequests(
            repositoryId, listed.map((l) => l.input.number),
          );
          if (closed > 0) logger.debug(`${repo.name}: ${closed} previously open pull request(s) are no longer open`);
        }

        store.setSyncState(scopeKey(repo.integration, repo.slug, 'pullrequests'), now.toISOString(), runId);
      } catch (error) {
        abortOnRefusedCredentials(error);
        warnings.push(`Pull requests for ${repo.name}: ${(error as Error).message}`);
        logger.warn(`pull requests · ${repo.name} — ${(error as Error).message}`);
      }
    }
  }

  // --- pipelines -----------------------------------------------------------
  if (config.cicd) {
    const { repositories, maxPipelines } = config.cicd;
    for (const [index, repo] of repositories.entries()) {
      const repositoryId = cicdRepoIds[index] as number;
      try {
        const client = registry.bitbucketClient(repo.integration);
        logger.step(`pipelines · ${repo.name}`);

        const pipelines = await client.listPipelines(repo.slug, cicdSince, maxPipelines);
        for (const pipeline of pipelines) {
          store.upsertPipeline({ ...pipeline.input, repositoryId }, pipeline.steps);
        }
        stats.pipelines += pipelines.length;

        store.setSyncState(scopeKey(repo.integration, repo.slug, 'pipelines'), now.toISOString(), runId);
      } catch (error) {
        abortOnRefusedCredentials(error);
        warnings.push(`Pipelines for ${repo.name}: ${(error as Error).message}`);
        logger.warn(`pipelines · ${repo.name} — ${(error as Error).message}`);
      }
    }
  }

  // --- Jira summaries ------------------------------------------------------
  for (const summary of config.jiraSummaries) {
    try {
      const client = registry.jiraClient(summary.integration);
      logger.step(`jira · ${summary.title}`);

      const found = await client.search(summary.jql, summary.maxResults);
      stats.issuesSeen += found.length;

      const issueIds: number[] = [];
      for (const result of found) {
        const issueId = store.upsertJiraIssue({ ...result.input, integrationId: summary.integration });
        issueIds.push(issueId);

        // Same split as pull requests: membership needs the full query, the
        // changelog behind each issue only needs fetching when it changed.
        if (!store.needsChangelog(issueId, result.updatedAt)) continue;

        const changes = await client.changes(result.input.key, result.input.createdAt);
        store.saveIssueChanges(issueId, changes, result.updatedAt);
        stats.issuesFetched += 1;
      }

      store.recordSummaryMembers(runId, summary.slug, issueIds);
      store.setSyncState(scopeKey(summary.integration, summary.slug, 'jira'), now.toISOString(), runId);
    } catch (error) {
      abortOnRefusedCredentials(error);
      warnings.push(`Jira summary "${summary.title}": ${(error as Error).message}`);
      logger.warn(`jira · ${summary.title} — ${(error as Error).message}`);

      // Carry the previous run's membership forward so the section still
      // renders, rather than silently reporting the summary as empty.
      const previous = store.previousRun(runId);
      if (previous) {
        const carried = store.issuesForSummary(previous.id, summary.slug).map((i) => i.id);
        if (carried.length > 0) store.recordSummaryMembers(runId, summary.slug, carried);
      }
    }
  }

  // Every section failing is a failed run, not a report full of holes.
  const sections = (config.pullRequests?.repositories.length ?? 0)
    + (config.cicd?.repositories.length ?? 0) + config.jiraSummaries.length;
  if (sections > 0 && warnings.length === sections) {
    throw new HealthError(
      'Every configured source failed to sync',
      warnings[0] ? `First failure: ${warnings[0]}` : undefined,
    );
  }

  store.setMeta(LAST_RUN_AT, now.toISOString());
  return { pullRequestRepoIds, cicdRepoIds, cicdSince, stats, warnings };
}
