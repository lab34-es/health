import { HttpClient } from './http.js';
import { IntegrationError } from '../util/errors.js';
import { firstParagraph } from './adf.js';
import type { Logger } from '../util/logger.js';
import type { IntegrationConfig } from '../config/types.js';
import type { IssueChangeInput, JiraIssueInput } from '../db/types.js';

const SEARCH_FIELDS = [
  'summary', 'description', 'status', 'issuetype',
  'assignee', 'reporter', 'created', 'updated', 'resolutiondate',
];

/** Endpoints missing on Jira Server/DC and older Cloud sites fall back. */
const ABSENT = new Set([404, 405, 410]);

interface JiraUser { displayName?: string; name?: string; accountId?: string }
interface JiraIssue {
  key: string;
  fields?: {
    summary?: string; description?: unknown;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    assignee?: JiraUser | null; reporter?: JiraUser | null;
    created?: string; updated?: string; resolutiondate?: string | null;
  };
  changelog?: { histories?: ChangelogEntry[] };
}

interface ChangelogEntry {
  created?: string;
  author?: JiraUser;
  items?: { field?: string; fieldId?: string; fromString?: string | null; toString?: string | null }[];
}

function userName(user: JiraUser | null | undefined): string | null {
  return user?.displayName ?? user?.name ?? user?.accountId ?? null;
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Jira's three status categories, under the names the report uses. */
export function statusCategory(key: string | undefined): string | null {
  switch (key) {
    case 'new': return 'to_do';
    case 'indeterminate': return 'in_progress';
    case 'done': return 'done';
    default: return null;
  }
}

export interface JiraSearchResult {
  input: Omit<JiraIssueInput, 'integrationId'>;
  updatedAt: string;
}

/** Where a scoped token's calls have to go; the site URL refuses them. */
const GATEWAY = 'https://api.atlassian.com/ex/jira';

export class JiraClient {
  private readonly http: HttpClient;
  /** The site URL — what ticket links are built from, always. */
  private readonly site: string;
  /** Resolved on first use, then reused for the rest of the run. */
  private modernSearch: boolean | undefined;
  /** The credential check runs once per run; this holds it for later callers. */
  private authenticated: Promise<void> | undefined;

  constructor(private readonly integration: IntegrationConfig, private readonly logger: Logger) {
    this.site = (integration.baseUrl ?? '').replace(/\/+$/, '');
    // A token created with scopes is only accepted at the gateway, addressed
    // by cloud id rather than by site name. Keeping the two apart means the
    // report's ticket links stay on the site URL either way — an
    // api.atlassian.com link is not one anybody can follow.
    const api = integration.cloudId ? `${GATEWAY}/${integration.cloudId}` : this.site;
    this.http = new HttpClient(integration, api, logger);
  }

  get id(): string { return this.integration.id; }

  /**
   * Runs a JQL query and returns every matching issue, up to `maxResults`.
   *
   * The full query runs on every sync: its job is to establish which issues a
   * summary matches *now*, which an incremental filter could not answer. Only
   * the per-issue changelog — the expensive part — is skipped for issues whose
   * `updated` has not moved since the last run.
   */
  async search(jql: string, maxResults: number): Promise<JiraSearchResult[]> {
    await this.requireAuthentication();

    const issues = this.modernSearch === false
      ? await this.searchLegacy(jql, maxResults)
      : await this.searchModern(jql, maxResults);

    return issues.map((issue) => {
      const fields = issue.fields ?? {};
      const updatedAt = iso(fields.updated) ?? iso(fields.created) ?? new Date().toISOString();
      return {
        updatedAt,
        input: {
          key: issue.key,
          type: fields.issuetype?.name ?? 'Task',
          title: fields.summary ?? issue.key,
          description: firstParagraph(fields.description),
          status: fields.status?.name ?? 'Unknown',
          statusCategory: statusCategory(fields.status?.statusCategory?.key),
          assignee: userName(fields.assignee),
          reporter: userName(fields.reporter),
          url: `${this.site}/browse/${issue.key}`,
          createdAt: iso(fields.created) ?? updatedAt,
          updatedAt,
          resolvedAt: iso(fields.resolutiondate),
        },
      };
    });
  }

  /**
   * Fails the summary when the credentials are not accepted.
   *
   * Jira does not answer an unauthenticated search with 401 — it runs the
   * query as an anonymous user, for whom every project is invisible, and
   * answers 200 with an empty issue list. A wrong username or token would
   * otherwise be indistinguishable from a JQL that genuinely matches nothing,
   * and the summary would silently report zero tickets. `myself` is the one
   * endpoint that does refuse anonymous callers, so it is asked first.
   */
  private async requireAuthentication(): Promise<void> {
    this.authenticated ??= (async () => {
      for (const path of ['/rest/api/3/myself', '/rest/api/2/myself']) {
        try {
          const me = await this.http.json<JiraUser>(path);
          this.logger.debug(`authenticated as ${userName(me) ?? 'an unnamed account'}`);
          return;
        } catch (error) {
          if (error instanceof IntegrationError && ABSENT.has(error.status ?? 0)) continue;
          if (error instanceof IntegrationError && (error.status === 401 || error.status === 403)) {
            throw new IntegrationError(
              this.integration.id,
              `${this.integration.name}: the credentials were not accepted (${error.status})`,
              error.status,
              this.integration.cloudId
                ? 'These calls go to the api.atlassian.com gateway, which only accepts a token '
                  + 'created *with* scopes — read:jira-work and read:jira-user. Check that the token '
                  + 'carries them and that cloud_id names this site.'
                : 'Check the username (the account e-mail) and the token. A token created *with* '
                  + 'scopes is refused here: scoped tokens are only accepted at the '
                  + 'api.atlassian.com gateway, so either create one without scopes or set cloud_id '
                  + 'for this integration to route the calls there.',
            );
          }
          throw error;
        }
      }
      this.logger.debug('no myself endpoint — skipping the credential check');
    })();

    await this.authenticated;
  }

  /** POST /rest/api/3/search/jql — token paginated (current Jira Cloud). */
  private async searchModern(jql: string, maxResults: number): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;

    for (;;) {
      let page: { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      try {
        page = await this.http.json('/rest/api/3/search/jql', {
          method: 'POST',
          body: {
            jql,
            fields: SEARCH_FIELDS,
            maxResults: Math.min(100, maxResults - issues.length),
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        });
      } catch (error) {
        if (issues.length === 0 && error instanceof IntegrationError && ABSENT.has(error.status ?? 0)) {
          this.logger.debug('search/jql is absent — falling back to the legacy search endpoint');
          this.modernSearch = false;
          return this.searchLegacy(jql, maxResults);
        }
        throw error;
      }

      this.modernSearch = true;
      issues.push(...(page.issues ?? []));
      nextPageToken = page.nextPageToken;
      if (!nextPageToken || page.isLast || issues.length >= maxResults) break;
    }

    return issues.slice(0, maxResults);
  }

  /** GET /rest/api/2/search — offset paginated (Jira Server/DC). */
  private async searchLegacy(jql: string, maxResults: number): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];

    for (;;) {
      const page = await this.http.json<{ issues?: JiraIssue[]; total?: number }>('/rest/api/2/search', {
        query: {
          jql,
          fields: SEARCH_FIELDS.join(','),
          startAt: issues.length,
          maxResults: Math.min(100, maxResults - issues.length),
        },
      });
      const batch = page.issues ?? [];
      issues.push(...batch);
      if (batch.length === 0 || issues.length >= maxResults || issues.length >= (page.total ?? 0)) break;
    }

    return issues.slice(0, maxResults);
  }

  /**
   * Status and assignee changes for one issue, oldest first.
   *
   * Jira's changelog records every field change; the timeline needs two of
   * them — status for the lanes, assignee for who was holding the ticket in
   * each one. The issue's creation is synthesised as the entry into its first
   * status, since Jira does not record one.
   */
  async changes(key: string, createdAt: string): Promise<IssueChangeInput[]> {
    const entries = await this.changelog(key);
    const out: IssueChangeInput[] = [];

    for (const entry of entries) {
      const changedAt = iso(entry.created);
      if (!changedAt) continue;
      for (const item of entry.items ?? []) {
        const field = item.fieldId ?? item.field;
        if (field !== 'status' && field !== 'assignee') continue;
        out.push({
          field,
          fromValue: item.fromString ?? null,
          toValue: item.toString ?? null,
          changedAt,
          author: userName(entry.author),
        });
      }
    }

    out.sort((a, b) => a.changedAt.localeCompare(b.changedAt));

    const firstStatus = out.find((c) => c.field === 'status')?.fromValue;
    if (firstStatus) {
      out.unshift({ field: 'status', fromValue: null, toValue: firstStatus, changedAt: createdAt, author: null });
    }
    return out;
  }

  private async changelog(key: string): Promise<ChangelogEntry[]> {
    const entries: ChangelogEntry[] = [];

    try {
      for (;;) {
        const page = await this.http.json<{ values?: ChangelogEntry[]; isLast?: boolean; total?: number }>(
          `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`,
          { query: { startAt: entries.length, maxResults: 100 } },
        );
        const batch = page.values ?? [];
        entries.push(...batch);
        if (batch.length === 0 || page.isLast || entries.length >= (page.total ?? 0)) break;
      }
      return entries;
    } catch (error) {
      if (!(error instanceof IntegrationError) || !ABSENT.has(error.status ?? 0)) throw error;
    }

    // Jira Server has no changelog collection; it rides along on the issue.
    const issue = await this.http.json<JiraIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
      query: { expand: 'changelog', fields: 'created' },
    });
    return issue.changelog?.histories ?? [];
  }
}
