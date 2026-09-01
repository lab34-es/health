import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { HealthError } from '../util/errors.js';
import { assertTimeZone } from '../util/time.js';
import {
  isRecord, optionalArray, optionalBoolean, optionalNumber, optionalString,
  requireArray, requireOneOf, requireRecord, requireString, type Raw,
} from '../util/assert.js';
import { resolveEnvPlaceholders } from './interpolate.js';
import { parseHoursRule, resolveColor } from './thresholds.js';
import type {
  CicdConfig, HealthConfig, IntegrationConfig, JiraSummaryConfig,
  PullRequestsConfig, ReportSettings, RepositoryConfig, TestingConfig,
} from './types.js';

const DEFAULT_TIMELINE_STATUSES = ['To Do', 'In Progress', 'Code Review', 'QA', 'Done'];

export function parseConfig(rawText: string, env: NodeJS.ProcessEnv = process.env): HealthConfig {
  let doc: unknown;
  try {
    doc = parseYaml(rawText);
  } catch (error) {
    throw new HealthError(`config.yaml is not valid YAML: ${(error as Error).message}`);
  }

  // Placeholders are resolved after parsing, so comments are left alone and
  // secrets never have to survive a round trip through YAML quoting rules.
  const root = requireRecord(resolveEnvPlaceholders(doc, env), 'config.yaml');
  const version = String(root.version ?? '');
  if (version !== '1') {
    throw new HealthError(
      `config.yaml declares version "${version || '(missing)'}", which this CLI does not understand`,
      'This build reads version "1".',
    );
  }

  const report = parseReportSettings(root.report);
  const integrations = parseIntegrations(root.integrations);
  const byId = new Map(integrations.map((i) => [i.id, i]));

  const config: HealthConfig = {
    version,
    report,
    integrations,
    testing: parseTesting(root.testing),
    jiraSummaries: parseJiraSummaries(root.jira_summaries, root.jira_defaults, byId),
  };

  const pullRequests = parsePullRequests(root.pullrequests, byId);
  if (pullRequests) config.pullRequests = pullRequests;
  const cicd = parseCicd(root.cicd, byId);
  if (cicd) config.cicd = cicd;

  return config;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<HealthConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new HealthError(`Cannot read ${path}`, 'The context directory must contain a config.yaml.');
  }
  return parseConfig(raw, env);
}

function parseReportSettings(value: unknown): ReportSettings {
  const raw = value === undefined || value === null ? {} : requireRecord(value, 'report');
  const timezone = optionalString(raw.timezone, 'report.timezone') ?? 'UTC';
  try {
    assertTimeZone(timezone);
  } catch {
    throw new HealthError(`report.timezone: "${timezone}" is not a known timezone`,
      'Use an IANA name such as "Europe/Brussels".');
  }

  const retention = raw.retention === undefined || raw.retention === null
    ? {}
    : requireRecord(raw.retention, 'report.retention');

  return {
    title: optionalString(raw.title, 'report.title') ?? 'lab34/health',
    clientLabel: optionalString(raw.client_label, 'report.client_label') ?? '',
    timezone,
    locale: optionalString(raw.locale, 'report.locale') ?? 'en-GB',
    // One run is a report with no history at all; the sparklines need two.
    historyRuns: Math.max(2, optionalNumber(raw.history_runs, 'report.history_runs', 8)),
    showEvolution: optionalBoolean(raw.show_evolution, true),
    retentionRuns: optionalNumber(retention.runs, 'report.retention.runs', 90),
    retentionReports: optionalNumber(retention.reports, 'report.retention.reports', 30),
  };
}

function parseIntegrations(value: unknown): IntegrationConfig[] {
  const list = requireArray(value, 'integrations');
  if (list.length === 0) throw new HealthError('integrations must declare at least one entry');

  const seen = new Set<string>();
  return list.map((entry, index) => {
    const where = `integrations[${index}]`;
    const raw = requireRecord(entry, where);
    const id = requireString(raw.id, `${where}.id`);
    if (seen.has(id)) throw new HealthError(`${where}.id: "${id}" is declared more than once`);
    seen.add(id);

    const type = requireOneOf(raw.type, ['bitbucket', 'jira'] as const, `${where}.type`);
    const baseUrl = optionalString(raw.base_url, `${where}.base_url`);
    if (type === 'jira' && !baseUrl) {
      throw new HealthError(`${where}.base_url is required for jira integrations`,
        'Point it at the site URL, e.g. "https://your-org.atlassian.net".');
    }

    const integration: IntegrationConfig = {
      id,
      name: optionalString(raw.name, `${where}.name`) ?? id,
      type,
      username: requireString(raw.username, `${where}.username`),
      token: requireString(raw.token, `${where}.token`),
      timeoutMs: optionalNumber(raw.timeout_ms, `${where}.timeout_ms`, 30_000),
      maxRetries: optionalNumber(raw.max_retries, `${where}.max_retries`, 3),
    };
    const workspace = optionalString(raw.workspace, `${where}.workspace`);
    if (workspace) integration.workspace = workspace;
    if (baseUrl) integration.baseUrl = baseUrl.replace(/\/+$/, '');

    const cloudId = optionalString(raw.cloud_id, `${where}.cloud_id`);
    if (cloudId) {
      if (type !== 'jira') {
        throw new HealthError(`${where}.cloud_id is only meaningful for jira integrations`,
          'Bitbucket tokens are scoped without a gateway; drop the key.');
      }
      integration.cloudId = cloudId;
    }
    return integration;
  });
}

function parseRepositories(
  value: unknown, where: string, byId: Map<string, IntegrationConfig>,
): RepositoryConfig[] {
  return requireArray(value, where).map((entry, index) => {
    const at = `${where}[${index}]`;
    const raw = requireRecord(entry, at);
    const integration = requireString(raw.integration, `${at}.integration`);
    const found = byId.get(integration);
    if (!found) {
      throw new HealthError(`${at}.integration: no integration with id "${integration}"`,
        `Declared ids: ${[...byId.keys()].join(', ') || '(none)'}.`);
    }
    if (found.type !== 'bitbucket') {
      throw new HealthError(`${at}.integration: "${integration}" is a ${found.type} integration`,
        'Repositories must point at a bitbucket integration.');
    }
    if (!found.workspace) {
      throw new HealthError(`integrations "${integration}" needs a workspace`,
        'Bitbucket repositories are addressed as workspace/slug.');
    }
    const slug = requireString(raw.slug, `${at}.slug`);
    return { name: optionalString(raw.name, `${at}.name`) ?? slug, integration, slug };
  });
}

function parsePullRequests(
  value: unknown, byId: Map<string, IntegrationConfig>,
): PullRequestsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = requireRecord(value, 'pullrequests');

  const indicators = requireArray(raw.age_indicators, 'pullrequests.age_indicators')
    .map((entry, index) => {
      const at = `pullrequests.age_indicators[${index}]`;
      const item = requireRecord(entry, at);
      // The brief spelled this both ways; accept either rather than being fussy.
      const colorValue = item.color ?? item.colour;
      const rule = requireString(item.hours, `${at}.hours`);
      return {
        slug: requireString(item.slug, `${at}.slug`),
        rule,
        color: resolveColor(requireString(colorValue, `${at}.color`), at),
        matches: parseHoursRule(rule, at),
      };
    });
  if (indicators.length === 0) {
    throw new HealthError('pullrequests.age_indicators must declare at least one indicator');
  }

  return {
    title: optionalString(raw.title, 'pullrequests.title') ?? 'Pull Requests Flow',
    state: requireOneOf(raw.state, ['OPEN', 'MERGED', 'DECLINED', 'ALL'] as const,
      'pullrequests.state', 'OPEN'),
    ageIndicators: indicators,
    repositories: parseRepositories(raw.repositories, 'pullrequests.repositories', byId),
  };
}

function parseCicd(value: unknown, byId: Map<string, IntegrationConfig>): CicdConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = requireRecord(value, 'cicd');
  return {
    title: optionalString(raw.title, 'cicd.title') ?? 'CICD Flow',
    windowHours: optionalNumber(raw.window_hours, 'cicd.window_hours', 24),
    maxPipelines: optionalNumber(raw.max_pipelines, 'cicd.max_pipelines', 40),
    repositories: parseRepositories(raw.repositories, 'cicd.repositories', byId),
  };
}

function parseTesting(value: unknown): TestingConfig {
  const raw = value === undefined || value === null ? {} : requireRecord(value, 'testing');
  return {
    title: optionalString(raw.title, 'testing.title') ?? 'Testing report',
    placeholder: optionalString(raw.placeholder, 'testing.placeholder')
      ?? 'No test data collected in this run.',
    hint: optionalString(raw.hint, 'testing.hint')
      ?? 'Section reserved — configure a testing integration in config.yaml',
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'summary';
}

function parseJiraSummaries(
  value: unknown, defaultsValue: unknown, byId: Map<string, IntegrationConfig>,
): JiraSummaryConfig[] {
  const list = optionalArray(value, 'jira_summaries');
  if (list.length === 0) return [];

  const defaults = defaultsValue === undefined || defaultsValue === null
    ? {} as Raw
    : requireRecord(defaultsValue, 'jira_defaults');
  const defaultIntegration = optionalString(defaults.integration, 'jira_defaults.integration');
  const defaultMaxResults = optionalNumber(defaults.max_results, 'jira_defaults.max_results', 50);
  const defaultStatuses = optionalArray(defaults.timeline_statuses, 'jira_defaults.timeline_statuses')
    .map((s, i) => requireString(s, `jira_defaults.timeline_statuses[${i}]`));

  const jiraIds = [...byId.values()].filter((i) => i.type === 'jira').map((i) => i.id);
  const seen = new Set<string>();

  return list.map((entry, index) => {
    const at = `jira_summaries[${index}]`;
    const raw = requireRecord(entry, at);
    const title = requireString(raw.title, `${at}.title`);

    // `slug` is optional in the brief's sketch, but the database keys history
    // by it — so derive a stable one from the title when it is absent.
    const slug = optionalString(raw.slug, `${at}.slug`) ?? slugify(title);
    if (seen.has(slug)) {
      throw new HealthError(`${at}.slug: "${slug}" is used by more than one summary`,
        'Summaries are keyed by slug so their history survives a title change; give each one its own.');
    }
    seen.add(slug);

    const integration = optionalString(raw.integration, `${at}.integration`)
      ?? defaultIntegration
      ?? (jiraIds.length === 1 ? jiraIds[0] : undefined);
    if (!integration) {
      throw new HealthError(`${at}.integration is required`,
        jiraIds.length === 0
          ? 'No jira integration is declared.'
          : `Set it here or in jira_defaults. Jira integrations: ${jiraIds.join(', ')}.`);
    }
    const found = byId.get(integration);
    if (!found) throw new HealthError(`${at}.integration: no integration with id "${integration}"`);
    if (found.type !== 'jira') {
      throw new HealthError(`${at}.integration: "${integration}" is a ${found.type} integration`);
    }

    const statuses = optionalArray(raw.timeline_statuses, `${at}.timeline_statuses`)
      .map((s, i) => requireString(s, `${at}.timeline_statuses[${i}]`));

    return {
      slug,
      title,
      // An empty JQL would return the whole backlog; the brief's example has
      // blanks as placeholders, so refuse them rather than fetching everything.
      jql: requireString(raw.jql, `${at}.jql`),
      integration,
      maxResults: optionalNumber(raw.max_results, `${at}.max_results`, defaultMaxResults),
      timelineStatuses: statuses.length > 0 ? statuses
        : defaultStatuses.length > 0 ? defaultStatuses
        : DEFAULT_TIMELINE_STATUSES,
    };
  });
}

export { isRecord };
