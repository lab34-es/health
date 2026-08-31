# YAML formats

Two YAML documents define everything `lab34-health` does.

| File | Written by | Read by | Purpose |
| --- | --- | --- | --- |
| `lab34-health-context/config.yaml` | you | the CLI | what to fetch and how to present it |
| `reports/<id>/index.yaml` | the CLI | the CLI, `index.html`, you | every datapoint the report shows |

Full, runnable examples live in [`examples/lab34-health-context/config.yaml`](../examples/lab34-health-context/config.yaml)
and [`examples/report/index.yaml`](../examples/report/index.yaml). This page explains the rules behind them.

---

## 1. `config.yaml`

### Interpolation

`"{{ env.NAME }}"` is replaced with `process.env.NAME` when the file is loaded.

The braces **must** be inside quotes. An unquoted `{{ env.X }}` is a YAML flow mapping and fails to
parse — the format sketched in the original brief is invalid YAML for exactly this reason. Whitespace
inside the braces is optional, so `"{{env.X}}"` also works. A referenced variable that is unset aborts
the run with exit code 1 and names the variable; secrets are never echoed back, in logs or errors.

### Structure

| Key | Required | Notes |
| --- | --- | --- |
| `version` | yes | `"1"` |
| `report` | no | title, client label, timezone, locale, history depth, retention |
| `integrations` | yes | credentialed endpoints, each with a unique `id` |
| `pullrequests` | no | section 03; omit to drop the section |
| `cicd` | no | section 04; omit to drop the section |
| `testing` | no | section 05 labels |
| `jira_defaults` | no | defaults merged into every `jira_summaries` entry |
| `jira_summaries` | no | section 06; one report section per entry |

Sections reference integrations by `id`, so credentials are declared once. A section that names an
unknown `id` fails validation before any network call is made.

### Age indicator rules

`pullrequests.age_indicators` is an ordered list; **the first matching rule wins**, so order matters.
`hours` accepts `< N`, `<= N`, `> N`, `>= N` and `N - M` (inclusive). A PR matching no rule renders
neutral. `color` takes a palette name (`green`, `yellow`, `red`, `grey`) or a literal `#RRGGBB`;
`colour` is accepted as an alias, since the original brief used both spellings.

### Jira timelines

`timeline_statuses` fixes the lane order of the per-ticket timeline. Any status Jira returns that is
not listed is folded into the nearest preceding listed lane, so a board with extra columns still
produces a five-lane timeline rather than an unbounded one.

---

## 2. `index.yaml`

`index.html` embeds a verbatim copy of this document and renders every section from it. The rule is
strict and worth stating plainly: **nothing appears in the report that is not written down here.**
Hand-editing a value in `index.yaml` and reloading the HTML changes the report.

### Four conventions

1. **Timestamps are ISO-8601 UTC.** Every timestamp that is *displayed* also carries a sibling
   `*_display` string, pre-formatted in `report.timezone`. The renderer never does timezone maths, so
   a report opened in Sydney shows the same numbers as one opened in Brussels.
2. **Numbers stay numbers.** `duration_seconds: 700` is the datum; `duration_display: "11m 40s"` is
   what gets painted. Both are present so the file stays useful for analysis, not just rendering.
3. **Semantics live in the YAML, pixels do not.** Fields carry an `indicator` (`ok` / `warning` /
   `problem` / `neutral`) or a `direction` (`better` / `worse` / `flat`), and `theme` maps those to
   hex. Whether 71 hours is a problem is a question about the team's config; what shade of red that
   is, is a question about the stylesheet. Keeping them apart is what lets the age thresholds in
   `config.yaml` reach the report without the renderer knowing they exist.

   `theme` is the only block holding colours, with exactly one exception: the resolved `color` on each
   `pull_requests.age_indicators` entry. Those are picked by the team in `config.yaml`, so they belong
   to the run's data rather than to the stylesheet. A test enforces the rule — any other hex appearing
   outside `theme` fails the build.
4. **Series align to one axis.** The top-level `runs` list is the history axis, oldest first. Every
   `series` in the document has exactly `runs.length` entries and is indexed against it, so bar and
   sparkline tooltips can name the run a value came from. A metric with no value for a given run
   carries `null` at that position rather than being shortened.

### Top-level keys

| Key | Contents |
| --- | --- |
| `version` | `"1"` |
| `report` | run number, timestamps, client label, scope counts, header/footer strings, `warnings` |
| `theme` | the colours: `palette`, `indicator`, `direction`, `named`, and `lanes` (one per configured timeline lane) |
| `navigation` | the sticky CONTENTS bar; `ref` names the section key it links to |
| `runs` | shared history axis, oldest first |
| `summary` | 01 — KPI cards with sparkline `series` and a `delta` |
| `evolution` | 02 — per-run bars per trend; `enabled: false` hides the section |
| `pull_requests` | 03 — `columns`, `default_sort`, resolved `age_indicators`, `items` |
| `cicd` | 04 — `headline` counters and pipeline `items` with per-step outcomes |
| `testing` | 05 — placeholder today; `status: empty` renders the dashed card |
| `jira_summaries` | 06 — a *list* of sections under `items`, one per configured summary |

### Partial runs

`report.warnings` holds one entry per source that failed to sync. A section whose source failed keeps
the last data collected for it rather than rendering empty, and the report shows a banner naming what
did not refresh. A run only fails outright when *every* configured source fails.

### Derived fields, and why they are stored

`delta.direction`, `age_indicator`, `emphasis` and `share` are all computable from other fields in the
document. They are written down anyway, because computing them requires knowing the team's
thresholds and each metric's `lower_is_better` — config that belongs to the run, not to the viewer.
Storing the verdict keeps a report reproducible: reopening a six-month-old file shows the judgement
that was made at the time, not the judgement today's thresholds would make.

### Pull request items

Each entry carries the repository, author, both branches, creation time and age with its resolved
indicator, file/line counts, comment and unresolved-thread counts, what is blocking it, one entry per
reviewer with that reviewer's own state, and the full commit list — collapsed in the UI by default.
`facts` is the expanded row's "Review & changes" panel: an ordered list of label/value/indicator
triples, so the panel's row order is data rather than markup.

### Jira ticket timelines

`timeline.total_hours` is the ticket's full span. Each lane holds `hours`, its `share` of the span, a
`time_display` (`h` under a day, `d` at or above), the people involved, and `segments` — one per visit
to that status, with `start_hours` offset and `duration_hours`. A ticket that enters Code Review
twice produces two segments in that lane.

Lane `hours` always sum to `total_hours`: whole hours are apportioned by largest remainder rather than
rounded independently, so a timeline's parts never fail to add up to its own total. A status the board
reports but `config.yaml` does not list is folded into the last listed lane the ticket passed through,
so blocked time is attributed rather than lost. `who` is the assignee in effect during each segment,
taken from the changelog's assignee history — not the person who moved the ticket, who is typically
the developer handing it on rather than whoever picked it up.

`emphasis` is `heavy` when a lane holds more than `timeline.heavy_share` of the span (default 0.35),
`empty` for an unvisited lane, `normal` otherwise. It is what makes "this ticket sat in review" visible
without reading numbers.
