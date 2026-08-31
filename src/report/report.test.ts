import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { buildReport } from './build.js';
import { openDatabase } from '../db/index.js';
import { parseConfig } from '../config/load.js';
import { renderHtml, unembedYaml } from './html.js';
import { seedFixture } from '../testing/fixture.js';
import { Store } from '../db/store.js';
import { toYaml } from './yaml.js';
import { writeReport } from './write.js';
import type { ReportDocument } from './model.js';

const NOW = new Date('2026-08-20T09:14:02Z');
const STARTED = new Date(NOW.getTime() - 192_000);
const ENV = {
  BITBUCKET_ACMEINTL_USERNAME: 'u', BITBUCKET_ACMEINTL_TOKEN: 't',
  JIRA_ACMEINTL_USERNAME: 'u', JIRA_ACMEINTL_TOKEN: 't',
} as NodeJS.ProcessEnv;

const dir = mkdtempSync(join(tmpdir(), 'lab34-health-report-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function build(): Promise<ReportDocument> {
  const config = parseConfig(
    await readFile(new URL('../../examples/lab34-health-context/config.yaml', import.meta.url), 'utf8'),
    ENV,
  );
  const db = openDatabase(join(dir, `${Math.random().toString(36).slice(2)}.sql`));
  const store = new Store(db);
  const { runId, repositoryIds } = seedFixture(db, store, NOW);

  const document = buildReport({
    config, store, runId, runNumber: runId, reportId: '2026-08-20T09-14-02Z',
    startedAt: STARTED, now: NOW, version: '1.0.0',
    sync: {
      pullRequestRepoIds: repositoryIds, cicdRepoIds: repositoryIds,
      cicdSince: new Date(NOW.getTime() - 24 * 3_600_000).toISOString(),
      stats: { pullRequestsSeen: 5, pullRequestsFetched: 5, pipelines: 6, issuesSeen: 7, issuesFetched: 7 },
      warnings: [],
    },
  });
  db.close();
  return document;
}

test('the report carries every section, numbered to match its contents bar', async () => {
  const doc = await build();

  assert.equal(doc.version, '1');
  assert.equal(doc.report.run.number, 482);
  assert.equal(doc.report.previous_run?.number, 481);
  assert.deepEqual(doc.navigation.map((n) => n.id),
    ['summary', 'evolution', 'pullrequests', 'cicd', 'testing', 'jira']);
  assert.deepEqual(doc.navigation.map((n) => n.index), ['01', '02', '03', '04', '05', '06']);

  // Each section's own index matches the number the contents bar shows.
  for (const entry of doc.navigation) {
    const section = doc[entry.ref as keyof ReportDocument] as { index: string };
    assert.equal(section.index, entry.index, `${entry.ref} index`);
  }

  assert.equal(doc.pull_requests?.items.length, 5);
  assert.equal(doc.cicd?.items.length, 6);
  assert.equal(doc.jira_summaries.items.length, 3);
  assert.equal(doc.jira_summaries.totals.tickets, 7);
  assert.equal(doc.testing.status, 'empty');
});

test('every series lines up with the runs axis', async () => {
  const doc = await build();
  const expected = doc.runs.length;

  assert.equal(expected, 8);
  for (const kpi of doc.summary.kpis) assert.equal(kpi.series.length, expected, kpi.id);
  for (const trend of doc.evolution.trends) assert.equal(trend.series.length, expected, trend.id);
  for (const group of doc.jira_summaries.items) assert.equal(group.series.length, expected, group.slug);
});

test('aggregates match the pull requests the report lists', async () => {
  const doc = await build();
  const section = doc.pull_requests as NonNullable<ReportDocument['pull_requests']>;
  const ages = section.items.map((pr) => pr.age_hours);

  assert.deepEqual(ages, [71, 52, 41, 19, 6]);
  assert.equal(section.headline.open_count, 5);
  assert.equal(section.headline.oldest_age_hours, 71);
  assert.equal(section.headline.average_age_hours, Math.round(ages.reduce((a, b) => a + b, 0) / ages.length));
  // Two are past the configured 48h threshold, and both are marked "problem".
  assert.equal(section.headline.over_threshold_count, 2);
  assert.deepEqual(section.items.map((pr) => pr.age_indicator),
    ['problem', 'problem', 'warning', 'ok', 'ok']);

  const kpi = doc.summary.kpis.find((k) => k.id === 'open_pull_requests');
  assert.equal(kpi?.value, 5);
  // The previous run held 6, so one fewer open is an improvement.
  assert.equal(kpi?.delta.direction, 'better');
});

test('what blocks a pull request is derived from its reviewers', async () => {
  const doc = await build();
  const byId = new Map((doc.pull_requests?.items ?? []).map((pr) => [pr.id, pr]));

  assert.equal(byId.get('project_backend#412')?.blocking.display, 'changes requested by s.peeters');
  assert.equal(byId.get('project_backend#412')?.blocking.indicator, 'problem');
  assert.equal(byId.get('project_frontend#288')?.blocking.display, 'awaiting first review');
  assert.equal(byId.get('project_backend#415')?.blocking.display, 'one review missing');
  assert.equal(byId.get('project_infra#97')?.blocking.display, 'nothing — ready to merge');
  assert.equal(byId.get('project_infra#97')?.blocking.indicator, 'ok');
});

test('pipeline steps and the notes drawn from them agree', async () => {
  const doc = await build();
  const failing = doc.cicd?.items.find((p) => p.id === 'project_backend#5521');

  assert.equal(failing?.outcome, 'FAILED');
  assert.deepEqual(failing?.failed_steps, ['integration-tests']);
  assert.deepEqual(failing?.skipped_steps, ['package', 'deploy-staging']);
  assert.equal(failing?.note.display, 'failed: integration-tests · skipped: package, deploy-staging');
  assert.equal(doc.cicd?.headline.total, 6);
  assert.equal(doc.cicd?.headline.passed, 4);
  assert.equal(doc.cicd?.headline.failed, 2);
});

test('ticket timelines account for every hour of every ticket', async () => {
  const doc = await build();
  const tickets = doc.jira_summaries.items.flatMap((s) => s.tickets);

  assert.equal(tickets.length, 7);
  for (const ticket of tickets) {
    const summed = ticket.timeline.lanes.reduce((a, l) => a + l.hours, 0);
    assert.equal(summed, ticket.timeline.total_hours, `${ticket.key} lanes sum`);
    assert.deepEqual(ticket.timeline.lanes.map((l) => l.status),
      doc.jira_summaries.timeline.statuses, `${ticket.key} lane order`);
  }

  const sdk = tickets.find((t) => t.key === 'PROJECT-1841');
  assert.deepEqual(sdk?.timeline.lanes.map((l) => l.hours), [72, 120, 96, 0, 0]);
  assert.deepEqual(sdk?.timeline.lanes.map((l) => l.who), ['unassigned', 'a.ruiz', 'm.dupont', '', '']);
  assert.equal(sdk?.timeline.lanes[1]?.emphasis, 'heavy');
});

test('the only colours in the document live under theme', async () => {
  const doc = await build();
  const yaml = toYaml(doc);
  const withoutTheme = { ...doc } as Record<string, unknown>;
  delete withoutTheme.theme;

  const hexes = JSON.stringify(withoutTheme).match(/#[0-9A-Fa-f]{6}/g) ?? [];
  // The one exception is the age indicators, whose colours the team chooses in
  // config.yaml, so they belong to the run's data rather than the stylesheet.
  const indicatorColors = new Set((doc.pull_requests?.age_indicators ?? []).map((i) => i.color));
  for (const hex of hexes) {
    assert.ok(indicatorColors.has(hex), `unexpected colour ${hex} outside theme`);
  }
  assert.ok(yaml.includes('theme:'));
});

test('the YAML round-trips and the HTML embeds the same text', async () => {
  const doc = await build();
  const yaml = toYaml(doc);

  // Serialising and reparsing yields the document it came from.
  assert.deepEqual(parseYaml(yaml), JSON.parse(JSON.stringify(doc)));

  const html = renderHtml(doc, yaml);
  const start = html.indexOf('<script type="application/yaml" id="report-data">');
  const embedded = html.slice(html.indexOf('>', start) + 2, html.indexOf('</script>', start) - 1);
  assert.equal(unembedYaml(embedded), yaml, 'embedded copy differs from index.yaml');

  assert.ok(html.includes('<title>ACME INTL — lab34/health</title>'));
  // The parser and renderer travel with the page rather than being fetched.
  assert.ok(html.includes('js-yaml'), 'YAML parser is not inlined');
  assert.ok(html.includes('lab34/health report renderer'), 'renderer is not inlined');
  assert.ok(!/<script[^>]+src=/.test(html), 'the page pulls in an external script');
});

test('a value containing a script tag cannot break out of the data block', async () => {
  const doc = await build();
  const target = doc.pull_requests?.items[0];
  assert.ok(target);
  target.title = 'Fix </script><script>alert(1)</script> escaping';

  const yaml = toYaml(doc);
  const html = renderHtml(doc, yaml);
  const block = html.slice(
    html.indexOf('<script type="application/yaml" id="report-data">'),
    html.indexOf('</script>', html.indexOf('id="report-data"')),
  );

  assert.ok(!block.includes('</script>'), 'the data block closes early');
  assert.ok(block.includes('<\\/script>'), 'the sequence was not escaped');
  assert.equal(parseYaml(unembedYaml(block.split('\n').slice(1).join('\n'))).pull_requests.items[0].title,
    'Fix </script><script>alert(1)</script> escaping');
});

test('writing a report leaves index.yaml and index.html side by side', async () => {
  const doc = await build();
  const reportsDir = join(dir, 'reports');
  const written = await writeReport(reportsDir, doc);

  const yaml = await readFile(written.yamlPath, 'utf8');
  const html = await readFile(written.htmlPath, 'utf8');

  assert.ok(written.dir.endsWith('2026-08-20T09-14-02Z'));
  assert.deepEqual(parseYaml(yaml).report.id, '2026-08-20T09-14-02Z');
  assert.ok(html.includes(yaml.trimEnd().split('\n').slice(-1)[0] as string));
});

test('the shipped example is what the tool currently emits', async () => {
  const doc = await build();
  const shipped = await readFile(new URL('../../examples/report/index.yaml', import.meta.url), 'utf8');
  assert.deepEqual(
    parseYaml(shipped), JSON.parse(JSON.stringify(doc)),
    'examples/report is stale — run `npm run example`',
  );
});
