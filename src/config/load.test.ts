import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { HealthError } from '../util/errors.js';
import { referencedEnvNames, resolveEnvPlaceholders } from './interpolate.js';
import { parseConfig } from './load.js';
import { parseHoursRule, resolveColor } from './thresholds.js';

const ENV = {
  BITBUCKET_ACMEINTL_USERNAME: 'bb-user',
  BITBUCKET_ACMEINTL_TOKEN: 'bb-token',
  JIRA_ACMEINTL_USERNAME: 'jira-user',
  JIRA_ACMEINTL_TOKEN: 'jira-token',
} as NodeJS.ProcessEnv;

const MINIMAL = `
version: "1"
integrations:
  - id: "bb"
    type: "bitbucket"
    workspace: "acme"
    username: "u"
    token: "t"
`;

test('loads the shipped example config end to end', async () => {
  const raw = await readFile(new URL('../../examples/lab34-health-context/config.yaml', import.meta.url), 'utf8');
  const config = parseConfig(raw, ENV);

  assert.equal(config.version, '1');
  assert.equal(config.report.clientLabel, 'ACME INTL');
  assert.equal(config.report.timezone, 'Europe/Brussels');
  assert.equal(config.integrations.length, 2);
  assert.equal(config.integrations[0]?.token, 'bb-token');
  assert.equal(config.pullRequests?.repositories.length, 3);
  assert.equal(config.cicd?.windowHours, 24);
  assert.equal(config.jiraSummaries.length, 3);
  // jira_defaults supplies the integration and lane order to every summary.
  assert.equal(config.jiraSummaries[0]?.integration, 'jira_ACMEintl');
  assert.deepEqual(config.jiraSummaries[0]?.timelineStatuses,
    ['To Do', 'In Progress', 'Code Review', 'QA', 'Done']);
  // The per-summary override wins over the default.
  assert.equal(config.jiraSummaries[2]?.maxResults, 25);
});

test('age indicators resolve colours and keep configured order', async () => {
  const raw = await readFile(new URL('../../examples/lab34-health-context/config.yaml', import.meta.url), 'utf8');
  const indicators = parseConfig(raw, ENV).pullRequests!.ageIndicators;

  assert.deepEqual(indicators.map((i) => i.slug), ['ok', 'warning', 'problem']);
  assert.deepEqual(indicators.map((i) => i.color), ['#3E7C4F', '#B68235', '#B3402F']);
  // First match wins: 30h is under 48 but not under 24.
  const firstMatch = (hours: number) => indicators.find((i) => i.matches(hours))?.slug;
  assert.equal(firstMatch(6), 'ok');
  assert.equal(firstMatch(30), 'warning');
  assert.equal(firstMatch(71), 'problem');
});

test('hours rules cover comparisons and ranges', () => {
  assert.equal(parseHoursRule('< 24', 'x')(23), true);
  assert.equal(parseHoursRule('< 24', 'x')(24), false);
  assert.equal(parseHoursRule('>= 48', 'x')(48), true);
  assert.equal(parseHoursRule('24 - 48', 'x')(24), true);
  assert.equal(parseHoursRule('24 - 48', 'x')(48), true);
  assert.equal(parseHoursRule('24 - 48', 'x')(49), false);
  assert.throws(() => parseHoursRule('soon', 'x'), HealthError);
  assert.throws(() => parseHoursRule('48 - 24', 'x'), HealthError);
});

test('colours accept palette names and hex, and reject anything else', () => {
  assert.equal(resolveColor('green', 'x'), '#3E7C4F');
  assert.equal(resolveColor('#abcdef', 'x'), '#ABCDEF');
  assert.throws(() => resolveColor('chartreuse', 'x'), HealthError);
});

test('a missing environment variable fails, naming it and not its value', () => {
  assert.throws(
    () => resolveEnvPlaceholders({ token: '{{ env.ABSENT_TOKEN }}' }, {} as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof HealthError
      && error.message.includes('ABSENT_TOKEN')
      && !error.message.includes('token:'),
  );
});

test('values needing no escaping survive interpolation intact', () => {
  const out = resolveEnvPlaceholders(
    { token: '{{ env.T }}', nested: [{ u: 'pre-{{env.U}}-post' }] },
    { T: 'a"b\\c: #d', U: 'x' } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(out, { token: 'a"b\\c: #d', nested: [{ u: 'pre-x-post' }] });
  assert.deepEqual(referencedEnvNames({ a: '{{env.X}}', b: ['{{ env.Y }}'] }), ['X', 'Y']);
});

test('comments mentioning a placeholder are not interpolated', () => {
  // The example config documents "{{ env.NAME }}" in a comment; a pre-parse
  // substitution would have demanded a NAME variable to exist.
  const config = parseConfig(
    '# uses "{{ env.NAME }}" for secrets\nversion: "1"\nintegrations:\n'
    + '  - { id: "bb", type: "bitbucket", workspace: "w", username: "u", token: "t" }\n',
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(config.integrations[0]?.token, 't');
});

test('unquoted placeholders are reported as the YAML mistake they are', () => {
  assert.throws(
    () => parseConfig('version: "1"\nintegrations:\n  - id: "bb"\n    token: {{ env.T }}\n', { T: 'x' } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof HealthError
      && /Wrap them in quotes/.test(error.hint ?? '')
      && error.message.includes('integrations[0].token'),
  );
});

test('sections referencing an unknown integration fail before any network call', () => {
  const raw = `${MINIMAL}
pullrequests:
  age_indicators:
    - { slug: "ok", hours: "< 24", color: "green" }
  repositories:
    - { name: "R", integration: "nope", slug: "r" }
`;
  assert.throws(() => parseConfig(raw, ENV),
    (error: unknown) => error instanceof HealthError && error.message.includes('no integration with id "nope"'));
});

test('two summaries cannot share a slug', () => {
  const raw = `${MINIMAL}
  - id: "j"
    type: "jira"
    base_url: "https://x.atlassian.net"
    username: "u"
    token: "t"
jira_summaries:
  - { title: "Tech debt", jql: "project = A" }
  - { title: "Tech  debt", jql: "project = B" }
`;
  assert.throws(() => parseConfig(raw, ENV),
    (error: unknown) => error instanceof HealthError && error.message.includes('more than one summary'));
});

test('an unknown config version is refused', () => {
  assert.throws(() => parseConfig('version: "2"\nintegrations: []\n', ENV),
    (error: unknown) => error instanceof HealthError && error.message.includes('version "2"'));
});

test('cloud_id is carried through for jira and refused elsewhere', () => {
  const raw = `${MINIMAL}
  - id: "j"
    type: "jira"
    base_url: "https://x.atlassian.net"
    cloud_id: "cloud-123"
    username: "u"
    token: "t"
`;
  const config = parseConfig(raw, ENV);
  assert.equal(config.integrations[1]?.cloudId, 'cloud-123');
  // base_url is untouched by it: the ticket links still come from the site.
  assert.equal(config.integrations[1]?.baseUrl, 'https://x.atlassian.net');

  assert.throws(() => parseConfig(`${MINIMAL}    cloud_id: "cloud-123"\n`, ENV),
    (error: unknown) => error instanceof HealthError && error.message.includes('only meaningful for jira'));
});
