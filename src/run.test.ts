import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

import { CONTEXT_DIR_NAME, resolveContext } from './context.js';
import { HealthError } from './util/errors.js';
import { main } from './cli.js';
import { run } from './run.js';
import { silentLogger } from './util/logger.js';

const dir = mkdtempSync(join(tmpdir(), 'lab34-health-run-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A context with credentials but no sections: the flow runs end to end and
// writes a report without any integration being contacted.
const CONFIG = `
version: "1"
report:
  title: "lab34/health"
  client_label: "ACME"
  timezone: "UTC"
integrations:
  - id: "bb"
    name: "Bitbucket"
    type: "bitbucket"
    workspace: "acme"
    username: "{{ env.BB_USER }}"
    token: "{{ env.BB_TOKEN }}"
`;

async function makeContext(name: string): Promise<string> {
  const cwd = join(dir, name);
  await mkdir(join(cwd, CONTEXT_DIR_NAME), { recursive: true });
  await writeFile(join(cwd, CONTEXT_DIR_NAME, 'config.yaml'), CONFIG, 'utf8');
  return cwd;
}

test('a missing context directory fails with an actionable message', async () => {
  const empty = join(dir, 'no-context');
  await mkdir(empty, { recursive: true });

  await assert.rejects(
    () => resolveContext({ cwd: empty }),
    (error: unknown) => error instanceof HealthError
      && error.message.includes(CONTEXT_DIR_NAME)
      && error.message.includes(empty)
      && /Create it with a config\.yaml/.test(error.hint ?? ''),
  );
});

test('an explicit context path is used as the context directory itself', async () => {
  // The directory is deliberately not called lab34-health-context, and does
  // not sit in the cwd the run is started from: both are what the flag is for.
  const elsewhere = join(dir, 'elsewhere', 'team-context');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, 'config.yaml'), CONFIG, 'utf8');

  const outcome = await run({
    cwd: dir, contextPath: elsewhere, logger: silentLogger,
    now: new Date('2026-08-20T09:14:02Z'),
    env: { BB_USER: 'u', BB_TOKEN: 't' } as NodeJS.ProcessEnv,
  });

  assert.ok(outcome.report.dir.startsWith(join(elsewhere, 'reports')), outcome.report.dir);
  assert.ok((await readFile(outcome.report.htmlPath, 'utf8')).includes('lab34/health'));
});

test('a relative context path resolves against the cwd, and a missing one fails', async () => {
  const relative = await run({
    cwd: join(dir, 'elsewhere'), contextPath: 'team-context', logger: silentLogger,
    env: { BB_USER: 'u', BB_TOKEN: 't' } as NodeJS.ProcessEnv,
  });
  assert.ok(relative.report.dir.includes(join('elsewhere', 'team-context')), relative.report.dir);

  await assert.rejects(
    () => resolveContext({ contextPath: join(dir, 'nowhere') }),
    (error: unknown) => error instanceof HealthError
      && error.message.includes(`No context directory at ${join(dir, 'nowhere')}`)
      && /--context-path/.test(error.hint ?? ''),
  );
});

async function captureStderr(fn: () => Promise<number>): Promise<[number, string]> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as never;
  try {
    return [await fn(), chunks.join('')];
  } finally {
    process.stderr.write = write;
  }
}

test('the CLI exits 1 when there is no context, and 0 for --help', async () => {
  const empty = join(dir, 'no-context');
  const [code, stderr] = await captureStderr(() => main(['--cwd', empty, '--no-color']));

  assert.equal(code, 1);
  // Assert on the failure itself, not on any text that merely mentions the
  // directory: the usage banner does too, so a rejected flag would otherwise
  // let this pass for the wrong reason.
  assert.match(stderr, /No lab34-health-context directory in/);
  assert.doesNotMatch(stderr, /Unknown option/);

  assert.equal(await main(['--help']), 0);
  assert.equal(await main(['--version']), 0);
});

test('every flag the usage text documents is actually accepted', async () => {
  const empty = join(dir, 'no-context');
  const flagSets = [
    ['--no-color'], ['-q'], ['-v'], ['--quiet', '--verbose', '--no-color'],
    ['--context-path', join(empty, CONTEXT_DIR_NAME)],
  ];
  for (const flags of flagSets) {
    const [, stderr] = await captureStderr(() => main(['--cwd', empty, ...flags]));
    assert.doesNotMatch(stderr, /Unknown option/, flags.join(' '));
  }
  const [, unknown] = await captureStderr(() => main(['--not-a-flag']));
  assert.match(unknown, /Unknown option/);
});

test('a run writes both report files and records itself in the database', async () => {
  const cwd = await makeContext('full');
  const now = new Date('2026-08-20T09:14:02Z');

  const outcome = await run({
    cwd, logger: silentLogger, now,
    env: { BB_USER: 'u', BB_TOKEN: 't' } as NodeJS.ProcessEnv,
  });

  assert.equal(outcome.runNumber, 1);
  assert.deepEqual(outcome.warnings, []);
  assert.ok(outcome.report.dir.endsWith('2026-08-20T09-14-02Z'));

  const doc = parseYaml(await readFile(outcome.report.yamlPath, 'utf8'));
  assert.equal(doc.report.client_label, 'ACME');
  assert.equal(doc.report.run.number, 1);
  assert.equal(doc.report.previous_run, null);
  // With no sections configured, only the placeholder survives; the contents
  // bar is renumbered so it does not show a gap where a section is absent.
  assert.equal(doc.pull_requests, null);
  assert.equal(doc.cicd, null);
  assert.deepEqual(doc.navigation.map((n: { id: string }) => n.id), ['summary', 'testing']);
  assert.deepEqual(doc.navigation.map((n: { index: string }) => n.index), ['01', '02']);
  assert.equal(doc.testing.index, '02');

  const html = await readFile(outcome.report.htmlPath, 'utf8');
  assert.ok(html.includes('<title>ACME — lab34/health</title>'));
});

test('a second run becomes the previous run of the next one', async () => {
  const cwd = await makeContext('history');
  const env = { BB_USER: 'u', BB_TOKEN: 't' } as NodeJS.ProcessEnv;

  await run({ cwd, logger: silentLogger, now: new Date('2026-08-19T09:00:00Z'), env });
  const second = await run({ cwd, logger: silentLogger, now: new Date('2026-08-20T09:00:00Z'), env });

  const doc = parseYaml(await readFile(second.report.yamlPath, 'utf8'));
  assert.equal(doc.report.run.number, 2);
  assert.equal(doc.report.previous_run.number, 1);
  assert.equal(doc.runs.length, 2);
  // last_run_at is what makes the next sync incremental.
  assert.match(
    await readFile(join(cwd, CONTEXT_DIR_NAME, 'database.sql'), 'latin1'),
    /last_run_at/,
  );
});

test('two runs in the same second get their own report directories', async () => {
  const cwd = await makeContext('same-second');
  const now = new Date('2026-08-20T09:14:02Z');
  const env = { BB_USER: 'u', BB_TOKEN: 't' } as NodeJS.ProcessEnv;

  const first = await run({ cwd, logger: silentLogger, now, env });
  const second = await run({ cwd, logger: silentLogger, now, env });

  assert.ok(first.report.dir.endsWith('2026-08-20T09-14-02Z'));
  assert.ok(second.report.dir.endsWith('2026-08-20T09-14-02Z-2'), second.report.dir);
  assert.equal(parseYaml(await readFile(second.report.yamlPath, 'utf8')).report.run.number, 2);
});

test('the CLI still runs when invoked through a symlink, as npm installs it', async () => {
  // npm links the bin into node_modules/.bin, so argv[1] is the link while
  // import.meta.url is the file it resolves to. Getting this wrong makes an
  // installed CLI exit 0 having done nothing, which no in-process test sees.
  const cwd = await makeContext('symlinked');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });

  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  const link = join(bin, 'lab34-health');
  await symlink(entry, link);

  const { stdout } = await execFileAsync(process.execPath, [link, '--no-color'], {
    cwd, env: { ...process.env, BB_USER: 'u', BB_TOKEN: 't' },
  });

  const reportPath = stdout.trim();
  assert.ok(reportPath.endsWith('index.html'), `stdout was ${JSON.stringify(stdout)}`);
  assert.ok((await readFile(reportPath, 'utf8')).includes('<title>ACME — lab34/health</title>'));
});

test('an unset credential stops the run before the database is touched', async () => {
  const cwd = await makeContext('missing-env');
  await assert.rejects(
    () => run({ cwd, logger: silentLogger, env: {} as NodeJS.ProcessEnv }),
    (error: unknown) => error instanceof HealthError
      && error.message.includes('BB_TOKEN')
      && !error.message.includes('token: '),
  );
});
