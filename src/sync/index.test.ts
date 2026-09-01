import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

import { IntegrationError } from '../util/errors.js';
import { Store } from '../db/store.js';
import { openDatabase } from '../db/index.js';
import { parseConfig } from '../config/load.js';
import { silentLogger } from '../util/logger.js';
import { sync } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'lab34-health-sync-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const CONFIG = `
version: "1"
integrations:
  - id: "bb"
    type: "bitbucket"
    workspace: "acme"
    username: "u"
    token: "t"
    max_retries: 0
  - id: "j"
    type: "jira"
    base_url: "https://example.atlassian.net"
    username: "u"
    token: "t"
    max_retries: 0
pullrequests:
  age_indicators:
    - { slug: "ok", hours: "< 24", color: "green" }
  repositories:
    - { name: "Backend", integration: "bb", slug: "backend" }
jira_summaries:
  - { slug: "debt", title: "Tech debt", jql: "project = A", integration: "j" }
`;

/** Answers Bitbucket normally and Jira with `jiraStatus`. */
function stubFetch(jiraStatus: number, bitbucketStatus = 200): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const jira = url.includes('atlassian.net') || url.includes('api.atlassian.com');
    const status = jira ? jiraStatus : bitbucketStatus;
    return new Response(JSON.stringify({ values: [], issues: [], isLast: true }), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function freshRun(name: string): { store: Store; runId: number } {
  const store = new Store(openDatabase(join(dir, `${name}.sql`)));
  return { store, runId: store.beginRun(name, '2026-09-01T00:00:00.000Z') };
}

test('refused Jira credentials fail the run instead of degrading to a warning', async () => {
  stubFetch(401);
  const { store, runId } = freshRun('refused');

  const error = await sync(parseConfig(CONFIG), store, runId, new Date(), silentLogger)
    .then(() => null, (e: Error) => e);

  // Bitbucket synced fine, so this is not the "every source failed" path: the
  // 401 alone has to be enough to fail the run and, through it, the CLI.
  assert.ok(error instanceof IntegrationError, `expected an IntegrationError, got ${String(error)}`);
  assert.equal(error.status, 401);
  assert.match(error.message, /credentials were not accepted/);
});

test('a source that is merely down still degrades to a warning', async () => {
  // 503 is an outage, not a configuration error: the report is still written.
  stubFetch(503);
  const { store, runId } = freshRun('outage');

  const result = await sync(parseConfig(CONFIG), store, runId, new Date(), silentLogger);

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /Tech debt/);
});
