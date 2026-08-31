// Regenerates examples/report/ from the fixture, through the real builder.
// Generating the example rather than hand-writing it keeps docs/formats.md
// describing a document the tool actually emits.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = process.env.HEALTH_DIST ?? join(root, 'dist-test');

const { parseConfig } = await import(join(dist, 'config/load.js'));
const { openDatabase } = await import(join(dist, 'db/index.js'));
const { Store } = await import(join(dist, 'db/store.js'));
const { seedFixture } = await import(join(dist, 'testing/fixture.js'));
const { buildReport } = await import(join(dist, 'report/build.js'));
const { toYaml } = await import(join(dist, 'report/yaml.js'));
const { renderHtml } = await import(join(dist, 'report/html.js'));

const NOW = new Date('2026-08-20T09:14:02Z');
const STARTED = new Date(NOW.getTime() - 192_000);

const config = parseConfig(
  await readFile(join(root, 'examples/lab34-health-context/config.yaml'), 'utf8'),
  {
    BITBUCKET_ACMEINTL_USERNAME: 'bitbucket-user',
    BITBUCKET_ACMEINTL_TOKEN: 'bitbucket-token',
    JIRA_ACMEINTL_USERNAME: 'jira-user',
    JIRA_ACMEINTL_TOKEN: 'jira-token',
  },
);

const scratch = mkdtempSync(join(tmpdir(), 'lab34-health-example-'));
try {
  const db = openDatabase(join(scratch, 'database.sql'));
  const store = new Store(db);
  const { runId, repositoryIds } = seedFixture(db, store, NOW);

  const document = buildReport({
    config, store, runId, runNumber: runId,
    reportId: '2026-08-20T09-14-02Z',
    startedAt: STARTED, now: NOW, version: '1.0.0',
    sync: {
      pullRequestRepoIds: repositoryIds,
      cicdRepoIds: repositoryIds,
      cicdSince: new Date(NOW.getTime() - 24 * 3_600_000).toISOString(),
      stats: { pullRequestsSeen: 5, pullRequestsFetched: 5, pipelines: 6, issuesSeen: 7, issuesFetched: 7 },
      warnings: [],
    },
  });

  const yaml = toYaml(document);
  const out = join(root, 'examples/report');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'index.yaml'), yaml, 'utf8');
  await writeFile(join(out, 'index.html'), renderHtml(document, yaml), 'utf8');

  db.close();
  process.stdout.write(`wrote examples/report/index.yaml (${yaml.length} bytes) and index.html\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
