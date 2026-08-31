#!/usr/bin/env node
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createLogger } from './util/logger.js';
import { HealthError } from './util/errors.js';
import { run } from './run.js';

const USAGE = `lab34-health — reports on the performance of development teams

Usage
  lab34-health [options]

Reads ./lab34-health-context/config.yaml, syncs from the configured Jira and
Bitbucket integrations into ./lab34-health-context/database.sql, and writes a
report to ./lab34-health-context/reports/<timestamp>/.

Options
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

Exit codes
  0  a report was written
  1  the run failed
`;

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cwd: { type: 'string', short: 'C' },
        'context-path': { type: 'string' },
        quiet: { type: 'boolean', short: 'q', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        // parseArgs has no --no-<flag> negation, so the negative form is its
        // own option rather than a default that cannot be turned off.
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }

  if (values.help) { process.stdout.write(USAGE); return 0; }
  if (values.version) { process.stdout.write(`${version()}\n`); return 0; }

  const logger = createLogger({
    quiet: values.quiet as boolean,
    verbose: values.verbose as boolean,
    ...(values['no-color'] as boolean ? { color: false } : {}),
  });

  try {
    const outcome = await run({
      cwd: values.cwd as string | undefined,
      contextPath: values['context-path'] as string | undefined,
      logger,
    });

    for (const warning of outcome.warnings) logger.warn(warning);
    logger.success(`run #${outcome.runNumber} written in ${outcome.durationSeconds}s`);

    // The report path goes to stdout so it can be piped; everything else is
    // progress reporting and belongs on stderr.
    process.stdout.write(`${outcome.report.htmlPath}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HealthError) {
      logger.error(error.message);
      if (error.hint) logger.info(error.hint);
    } else {
      logger.error((error as Error).message);
      if ((values.verbose as boolean) && (error as Error).stack) {
        process.stderr.write(`${(error as Error).stack}\n`);
      }
    }
    return 1;
  }
}

/**
 * True when this file is the process entry point.
 *
 * npm installs the bin as a symlink, so process.argv[1] is the link in
 * node_modules/.bin while import.meta.url is the resolved file it points at —
 * comparing them raw makes an installed CLI exit 0 without doing anything.
 * Resolving the link first is what makes the two comparable, and
 * pathToFileURL rather than string interpolation keeps paths containing
 * spaces or Windows drive letters working.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
