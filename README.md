# @lab34/health

Reports on the performance of development teams. Pulls pull requests and pipelines from Bitbucket and
work items from Jira, keeps them in a local SQLite database, and writes a self-contained HTML report
you can share.

```bash
npm install -g @lab34/health
lab34-health
```

## How a run works

1. `lab34-health` looks for a `lab34-health-context` directory in the current directory. If there
   isn't one, it exits 1 and says so. It does **not** search parent directories — which directory you
   run from decides which team you report on. Pass `--context-path <dir>` to use a context that
   lives somewhere else.
2. It reads `./lab34-health-context/config.yaml`, resolving `"{{ env.NAME }}"` placeholders from the
   environment.
3. It fetches what has changed since the last run and syncs it into
   `./lab34-health-context/database.sql`.
4. It writes `./lab34-health-context/reports/<timestamp>/` containing `index.html` and `index.yaml`.
5. It records `last_run_at`, so the next run knows where it left off.

The path of the report goes to stdout; progress goes to stderr, so `open "$(lab34-health)"` works.

## Setting up a context

```
your-project/
└── lab34-health-context/
    ├── config.yaml        ← you write this
    ├── database.sql       ← created and maintained by the CLI
    └── reports/           ← one directory per run
```

Copy [`examples/lab34-health-context/config.yaml`](examples/lab34-health-context/config.yaml) as a
starting point — it documents every key — then export the credentials it refers to:

```bash
export BITBUCKET_INTL_USERNAME=... BITBUCKET_INTL_TOKEN=...   # app password
export JIRA_INTL_USERNAME=... JIRA_INTL_TOKEN=...             # API token
lab34-health
```

### A context somewhere else

`--context-path` points the run at a directory directly, wherever it is and whatever it is called —
useful for keeping contexts outside the project, or for reporting on several teams from one place:

```bash
lab34-health --context-path ~/contexts/acme
lab34-health --context-path ~/contexts/globex
```

The directory is used as the context itself, so `config.yaml`, `database.sql` and `reports/` live
directly inside it. A relative path resolves against `--cwd` (the current directory by default).

Credentials are read from the environment and sent in an `Authorization` header. They are never
written to the database, the report, or any log or error message.

Both YAML formats are specified in [`docs/formats.md`](docs/formats.md), with a full worked example of
each under [`examples/`](examples/).

## What the report contains

| Section | Contents |
| --- | --- |
| 01 Summary | KPI cards with a sparkline per metric and a delta against the previous run |
| 02 Evolution | One bar per run per trend, coloured by whether that run moved the right way |
| 03 Pull Requests Flow | Open pull requests with age indicators, sortable, expanding to commits and review state |
| 04 CICD Flow | Recent pipelines with per-step outcomes and what failed or was skipped |
| 05 Testing report | Reserved — renders an empty state until a testing integration exists |
| 06 Jira summaries | One section per configured JQL query, each ticket with a status timeline |

Omit a section from `config.yaml` and it disappears from the report, with the contents bar renumbered
so there is no gap.

### The report reads its own YAML

`index.html` embeds a verbatim copy of `index.yaml` and builds every section from it at load time, so
**nothing appears in the report that is not written down in the YAML**. Edit a value in the embedded
copy, reload, and the report changes.

The page carries its own stylesheet, its own YAML parser and its renderer, with no build step and
nothing fetched at runtime except web fonts, which fall back to a system stack. It survives being
emailed around or dropped on a SharePoint site.

`index.yaml` is also the machine-readable record of the run: every number the report shows, with its
history, in a format you can diff between runs or read from another tool.

## Fetching only what changed

The cheap listing call always runs in full. For Bitbucket that is the only way to learn that a pull
request held as open has since been merged; for Jira, a summary's membership is a question about
*now* that an "updated since" filter cannot answer.

What is skipped is the expensive per-item detail — diffstat, commits, activity, changelogs — for
items whose `updated_at` has not moved past what is already stored. On a typical second run that is
most of them.

Aggregates are stored per run rather than recomputed, so a report's history stays truthful after the
underlying pull requests and tickets move on.

## When a source is down

A source that fails to sync records a warning and keeps the data last collected for it; the report
renders with a banner naming what did not refresh. A run fails outright only when *every* configured
source fails. A report built from yesterday's Jira and today's Bitbucket beats no report, as long as
it says so.

## Options

```
-C, --cwd <dir>   Directory holding lab34-health-context (default: .)
    --context-path <dir>
                  Use this directory as the context instead of looking for
                  lab34-health-context; may be relative to --cwd, and its
                  name does not matter
-q, --quiet       Only report failures
-v, --verbose     Log every request and sync decision
    --no-color    Disable coloured output
-h, --help        Show this help
    --version     Show the version
```

Exit code 0 means a report was written; 1 means the run failed.

## Development

```bash
npm install
npm run build       # compile to dist/
npm test            # unit and end-to-end tests
npm run typecheck
npm run example     # regenerate examples/report/ from the fixture
```

`examples/report/` is generated by the real report builder from a fixture, and a test fails if it goes
stale — so the documented format is always one the tool actually emits.

Requires Node 20 or newer.

## Releasing

```bash
npm run release -- patch    # or minor, major
```

The script refuses to run unless the working tree is clean, you are on `master`, and that branch is in
sync with `origin`. It then runs the tests, bumps the version in `package.json`, commits and tags it,
pushes the branch and tag, and publishes to npmjs (`prepublishOnly` rebuilds `dist/` from scratch).

Override the defaults with environment variables when needed:

```bash
RELEASE_BRANCH=main npm run release -- minor
SKIP_TESTS=1 npm run release -- patch
```

## Compatibility

Built against Bitbucket Cloud and Jira Cloud. Jira Server/Data Center is handled on a best-effort
basis: the client tries the current Cloud endpoints and falls back to the Server shapes when they are
absent, and reads descriptions as either ADF or wiki markup.

## License

MIT
