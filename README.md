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
export BITBUCKET_INTL_USERNAME=... BITBUCKET_INTL_TOKEN=...   # e-mail + scoped API token
export JIRA_INTL_USERNAME=... JIRA_INTL_TOKEN=...             # e-mail + API token
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
written to the database, the report, or any log or error message. Which token to create, and with
which scopes, is in [Atlassian credentials](#atlassian-credentials) below.

Both YAML formats are specified in [`docs/formats.md`](docs/formats.md), with a full worked example of
each under [`examples/`](examples/).

## Atlassian credentials

Both integrations authenticate the same way: an HTTP Basic `Authorization` header built from the
`username` and `token` of the integration. Both want an **Atlassian API token** — Bitbucket app
passwords reached end of life on 9 June 2026 and are no longer accepted.

Create tokens at
[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

| | Jira | Bitbucket |
| --- | --- | --- |
| `username` | your Atlassian account e-mail | your Atlassian account e-mail — **not** your Bitbucket username |
| `token` | API token, scoped or not — see below | API token, created **with** the three scopes below |
| `base_url` | `https://your-site.atlassian.net` | `https://api.bitbucket.org/2.0` (the default) |

Use one token per product; a Bitbucket token carries Bitbucket scopes and cannot read Jira.

### Bitbucket scopes

| Scope | Why it is needed |
| --- | --- |
| `read:repository:bitbucket` | Makes the workspace and each configured repository visible, and covers a pull request's commits and diffstat |
| `read:pullrequest:bitbucket` | The pull request listing, detail and activity feed behind section 03 |
| `read:pipeline:bitbucket` | Pipelines and their steps, behind section 04 |

Grant all three. Bitbucket's scopes do not imply one another — `read:pullrequest:bitbucket` on its
own does not grant repository read — and nothing beyond them is needed, since the tool only ever
issues GETs. Drop `read:pipeline:bitbucket` if you omit the `cicd` section, and
`read:pullrequest:bitbucket` if you omit `pullrequests`.

### Jira scopes

Either kind of Atlassian API token works, but they are addressed differently — a token created
**with** scopes is refused at the site URL, and only accepted at
`https://api.atlassian.com/ex/jira/<cloudId>`.

**Unscoped** (the simplest): create the token with **"Create API token"**, leave `cloud_id` out, and
`base_url` serves as both the API host and the source of ticket links. No scopes to choose.

**Scoped**: create it with **"Create API token with scopes"**, granting `read:jira-work` (JQL search,
issue fields, changelogs) and `read:jira-user` (the identity check, plus assignee and reporter
names). Then set `cloud_id`, which routes the API calls to the gateway while `base_url` goes on
building the ticket links — those have to stay on the site to be clickable:

```yaml
  - id: "jira_acme"
    type: "jira"
    base_url: "https://acme.atlassian.net"             # ticket links
    cloud_id: "8a0de62b-7c72-4a49-a62b-48bd36a5023b"   # API calls
```

Find the cloud id with:

```bash
curl -s https://your-site.atlassian.net/_edge/tenant_info
```

Mismatch the two and the run fails its credential check with `the credentials were not accepted
(401)` — a scoped token without `cloud_id`, or an unscoped one with it. Scopes cannot be added to an
existing token; switching between the two means creating a new one.

### What the account behind the token must be able to see

Scopes only cap what a token may do; the account's own permissions still apply.

- **Jira** — *Browse Projects* on every project a configured JQL touches. Jira answers an
  unauthorised search with an empty result set rather than an error, so a project the account cannot
  see looks like a summary that matches nothing. The run therefore checks `/myself` first and fails
  the integration outright when the credentials are refused.
- **Bitbucket** — read access to the workspace and to each repository listed under `pullrequests`
  and `cicd`.

### Endpoints called

Everything the tokens are used for, in full:

| Product | Endpoints |
| --- | --- |
| Jira | `GET /rest/api/3/myself`, `POST /rest/api/3/search/jql`, `GET /rest/api/3/issue/{key}/changelog` (falling back to `/rest/api/2/myself`, `/rest/api/2/search` and `/rest/api/2/issue/{key}?expand=changelog` on Server/DC) |
| Bitbucket | `GET /repositories/{workspace}/{slug}/pullrequests`, `.../pullrequests/{id}`, `.../diffstat`, `.../commits`, `.../activity`, `.../pipelines`, `.../pipelines/{uuid}/steps/` |

### Expiry

Atlassian API tokens expire between 1 and 365 days after creation. An expired or revoked token fails
the run for that integration with `the credentials were not accepted (401)`; if the other integration
still syncs, the report is written with a banner naming what did not refresh.

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
