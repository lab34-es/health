import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { JiraClient } from './jira.js';
import { IntegrationError } from '../util/errors.js';
import { silentLogger } from '../util/logger.js';
import type { IntegrationConfig } from '../config/types.js';

const integration: IntegrationConfig = {
  id: 'jira_test',
  name: 'Test Jira',
  type: 'jira',
  username: 'someone@example.com',
  token: 'not-a-token',
  baseUrl: 'https://example.atlassian.net',
  timeoutMs: 1000,
  maxRetries: 0,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers each request from `routes`, keyed by the path it asks for. */
function stubFetch(routes: Record<string, { status: number; body?: unknown }>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    const route = routes[path] ?? { status: 404 };
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

test('rejected credentials fail the search instead of reporting no tickets', async () => {
  // Jira runs an unauthenticated search as an anonymous user and answers 200
  // with an empty list, so only `myself` reveals that the token is wrong.
  const seen = stubFetch({
    '/rest/api/3/myself': { status: 401 },
    '/rest/api/3/search/jql': { status: 200, body: { issues: [], isLast: true } },
  });

  const client = new JiraClient(integration, silentLogger);
  const error = await client.search('project = LOOP', 50).then(() => null, (e: Error) => e);

  assert.ok(error instanceof IntegrationError, 'expected an IntegrationError');
  assert.equal(error.status, 401);
  assert.match(error.message, /credentials were not accepted/);
  // The query is never sent, so its empty answer cannot be mistaken for a result.
  assert.deepEqual(seen, ['/rest/api/3/myself']);
});

test('the credential check runs once and then lets searches through', async () => {
  const seen = stubFetch({
    '/rest/api/3/myself': { status: 200, body: { displayName: 'A Tester' } },
    '/rest/api/3/search/jql': {
      status: 200,
      body: {
        isLast: true,
        issues: [{
          key: 'LOOP-1',
          fields: {
            summary: 'A ticket', status: { name: 'Done', statusCategory: { key: 'done' } },
            issuetype: { name: 'Task' }, created: '2026-08-01T10:00:00.000Z',
            updated: '2026-08-02T10:00:00.000Z', resolutiondate: '2026-08-02T10:00:00.000Z',
          },
        }],
      },
    },
  });

  const client = new JiraClient(integration, silentLogger);
  const first = await client.search('project = LOOP', 50);
  await client.search('project = TLOC', 50);

  assert.equal(first.length, 1);
  assert.equal(first[0]?.input.key, 'LOOP-1');
  assert.equal(first[0]?.input.statusCategory, 'done');
  assert.equal(seen.filter((p) => p.endsWith('/myself')).length, 1);
});

test('a site without a myself endpoint still searches', async () => {
  const seen = stubFetch({
    '/rest/api/3/myself': { status: 404 },
    '/rest/api/2/myself': { status: 404 },
    '/rest/api/3/search/jql': { status: 200, body: { issues: [], isLast: true } },
  });

  const client = new JiraClient(integration, silentLogger);
  assert.deepEqual(await client.search('project = LOOP', 50), []);
  assert.ok(seen.includes('/rest/api/3/search/jql'));
});

test('a scoped token reaches the gateway while ticket links stay on the site', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const body = url.endsWith('/myself')
      ? { displayName: 'A Tester' }
      : {
        isLast: true,
        issues: [{
          key: 'LOOP-7',
          fields: {
            summary: 'Scoped', status: { name: 'Done', statusCategory: { key: 'done' } },
            created: '2026-08-01T10:00:00.000Z', updated: '2026-08-02T10:00:00.000Z',
          },
        }],
      };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new JiraClient({ ...integration, cloudId: 'cloud-123' }, silentLogger);
  const results = await client.search('project = LOOP', 50);

  // Every call goes to the gateway; the site URL would refuse a scoped token.
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith('https://api.atlassian.com/ex/jira/cloud-123/rest/'), `sent to ${url}`);
  }
  // api.atlassian.com is not a link anyone can follow, so tickets keep the site.
  assert.equal(results[0]?.input.url, 'https://example.atlassian.net/browse/LOOP-7');
});
