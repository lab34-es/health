-- Bookkeeping ---------------------------------------------------------------

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   TEXT    NOT NULL UNIQUE,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  status      TEXT    NOT NULL DEFAULT 'running',  -- running | ok | failed
  duration_ms INTEGER,
  error       TEXT
);

CREATE INDEX runs_started_at ON runs (started_at DESC);

-- Per-run values behind the sparklines and evolution bars. Aggregates are
-- stored rather than recomputed so a report's history stays truthful even
-- after the underlying tickets and pull requests move on.
CREATE TABLE run_metrics (
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  metric TEXT    NOT NULL,
  value  REAL,
  PRIMARY KEY (run_id, metric)
) WITHOUT ROWID;

-- Incremental-fetch watermarks. One row per (integration, repository, kind),
-- holding the newest updated_at we have already stored for that scope.
CREATE TABLE sync_state (
  scope          TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_run_id    INTEGER REFERENCES runs (id) ON DELETE SET NULL
) WITHOUT ROWID;

-- Bitbucket -----------------------------------------------------------------

CREATE TABLE repositories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  UNIQUE (integration_id, slug)
);

CREATE TABLE pull_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id      INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  title              TEXT    NOT NULL,
  description        TEXT,
  state              TEXT    NOT NULL,             -- OPEN | MERGED | DECLINED | SUPERSEDED
  author             TEXT    NOT NULL,
  author_display     TEXT,
  source_branch      TEXT    NOT NULL,
  destination_branch TEXT    NOT NULL,
  url                TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  closed_at          TEXT,
  merged_at          TEXT,
  first_review_at    TEXT,                          -- feeds review turnaround
  files_changed      INTEGER NOT NULL DEFAULT 0,
  lines_added        INTEGER NOT NULL DEFAULT 0,
  lines_removed      INTEGER NOT NULL DEFAULT 0,
  comment_count      INTEGER NOT NULL DEFAULT 0,
  unresolved_count   INTEGER NOT NULL DEFAULT 0,
  detail_fetched_at  TEXT,                          -- when commits/diffstat last synced
  UNIQUE (repository_id, number)
);

CREATE INDEX pull_requests_state ON pull_requests (state, updated_at DESC);

CREATE TABLE pull_request_commits (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  sha             TEXT    NOT NULL,
  message         TEXT    NOT NULL,
  author          TEXT,
  committed_at    TEXT,
  position        INTEGER NOT NULL,
  PRIMARY KEY (pull_request_id, sha)
) WITHOUT ROWID;

CREATE TABLE pull_request_reviewers (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  user_name       TEXT    NOT NULL,
  display_name    TEXT,
  state           TEXT    NOT NULL,                 -- approved | changes_requested | pending
  updated_at      TEXT,
  PRIMARY KEY (pull_request_id, user_name)
) WITHOUT ROWID;

CREATE TABLE pipelines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  branch        TEXT    NOT NULL,
  commit_sha    TEXT,
  triggered_by  TEXT    NOT NULL,
  trigger_type  TEXT,
  outcome       TEXT    NOT NULL,                   -- PASSED | FAILED | STOPPED | RUNNING
  url           TEXT,
  created_at    TEXT    NOT NULL,
  completed_at  TEXT,
  duration_ms   INTEGER,
  UNIQUE (repository_id, number)
);

CREATE INDEX pipelines_created_at ON pipelines (created_at DESC);

CREATE TABLE pipeline_steps (
  pipeline_id INTEGER NOT NULL REFERENCES pipelines (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,                     -- passed | failed | skipped | running
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pipeline_id, position)
) WITHOUT ROWID;

-- Jira ----------------------------------------------------------------------

CREATE TABLE jira_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id  TEXT NOT NULL,
  issue_key       TEXT NOT NULL,
  issue_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL,
  status_category TEXT,
  assignee        TEXT,
  reporter        TEXT,
  url             TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT,
  changelog_at    TEXT,                             -- when the changelog last synced
  UNIQUE (integration_id, issue_key)
);

CREATE INDEX jira_issues_updated_at ON jira_issues (updated_at DESC);

-- One row per tracked field change, oldest first. Status changes give the
-- timeline its lanes; assignee changes give each lane its "who". Storing raw
-- changes rather than a rendered timeline means a lane-order change in
-- config.yaml re-renders history correctly without refetching from Jira.
CREATE TABLE jira_issue_changes (
  issue_id   INTEGER NOT NULL REFERENCES jira_issues (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  field      TEXT    NOT NULL,            -- status | assignee
  from_value TEXT,
  to_value   TEXT,
  changed_at TEXT    NOT NULL,
  author     TEXT,
  PRIMARY KEY (issue_id, position)
) WITHOUT ROWID;

-- Which issues a summary's JQL matched on a given run. Keyed by slug so a
-- summary keeps its history when its title or JQL is edited.
CREATE TABLE jira_summary_members (
  run_id       INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  summary_slug TEXT    NOT NULL,
  issue_id     INTEGER NOT NULL REFERENCES jira_issues (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  PRIMARY KEY (run_id, summary_slug, issue_id)
) WITHOUT ROWID;
