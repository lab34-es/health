export interface RunRow {
  id: number;
  report_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  duration_ms: number | null;
}

export interface PullRequestInput {
  repositoryId: number;
  number: number;
  title: string;
  description: string | null;
  state: string;
  author: string;
  authorDisplay: string | null;
  sourceBranch: string;
  destinationBranch: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface PullRequestDetail {
  firstReviewAt: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commentCount: number;
  unresolvedCount: number;
}

export interface CommitInput {
  sha: string;
  message: string;
  author: string | null;
  committedAt: string | null;
}

export interface ReviewerInput {
  userName: string;
  displayName: string | null;
  state: 'approved' | 'changes_requested' | 'pending';
  updatedAt: string | null;
}

export interface PullRequestRecord {
  id: number;
  repositoryName: string;
  repositorySlug: string;
  integrationId: string;
  number: number;
  title: string;
  description: string | null;
  state: string;
  author: string;
  authorDisplay: string | null;
  sourceBranch: string;
  destinationBranch: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  firstReviewAt: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commentCount: number;
  unresolvedCount: number;
  commits: CommitInput[];
  reviewers: ReviewerInput[];
}

export interface PipelineInput {
  repositoryId: number;
  number: number;
  name: string;
  branch: string;
  commitSha: string | null;
  triggeredBy: string;
  triggerType: string | null;
  outcome: string;
  url: string | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface StepInput {
  name: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'running';
  durationMs: number;
}

export interface PipelineRecord extends Omit<PipelineInput, 'repositoryId'> {
  id: number;
  repositoryName: string;
  repositorySlug: string;
  integrationId: string;
  steps: StepInput[];
}

export interface JiraIssueInput {
  integrationId: string;
  key: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  statusCategory: string | null;
  assignee: string | null;
  reporter: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type ChangeField = 'status' | 'assignee';

export interface IssueChangeInput {
  field: ChangeField;
  fromValue: string | null;
  toValue: string | null;
  changedAt: string;
  author: string | null;
}

export interface JiraIssueRecord extends JiraIssueInput {
  id: number;
  changes: IssueChangeInput[];
}
