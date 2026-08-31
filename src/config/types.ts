export type IntegrationType = 'bitbucket' | 'jira';

export interface IntegrationConfig {
  id: string;
  name: string;
  type: IntegrationType;
  username: string;
  token: string;
  /** Bitbucket only: the workspace holding the configured repositories. */
  workspace?: string;
  /** Required for jira (the site URL); optional override for bitbucket. */
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface RepositoryConfig {
  name: string;
  integration: string;
  slug: string;
}

/** One `age_indicators` entry, with its `hours` expression already parsed. */
export interface AgeIndicator {
  slug: string;
  rule: string;
  color: string;
  matches: (hours: number) => boolean;
}

export interface PullRequestsConfig {
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'ALL';
  ageIndicators: AgeIndicator[];
  repositories: RepositoryConfig[];
}

export interface CicdConfig {
  title: string;
  windowHours: number;
  maxPipelines: number;
  repositories: RepositoryConfig[];
}

export interface TestingConfig {
  title: string;
  placeholder: string;
  hint: string;
}

export interface JiraSummaryConfig {
  slug: string;
  title: string;
  jql: string;
  integration: string;
  maxResults: number;
  timelineStatuses: string[];
}

export interface ReportSettings {
  title: string;
  clientLabel: string;
  timezone: string;
  locale: string;
  historyRuns: number;
  showEvolution: boolean;
  retentionRuns: number;
  retentionReports: number;
}

export interface HealthConfig {
  version: string;
  report: ReportSettings;
  integrations: IntegrationConfig[];
  pullRequests?: PullRequestsConfig;
  cicd?: CicdConfig;
  testing: TestingConfig;
  jiraSummaries: JiraSummaryConfig[];
}
