import { createRequire } from 'node:module';

import { buildReport } from './report/build.js';
import { loadConfig } from './config/load.js';
import { openDatabase } from './db/index.js';
import { pruneReports, writeReport, type WrittenReport } from './report/write.js';
import { HealthError } from './util/errors.js';
import { resolveContext } from './context.js';
import { reportId as toReportId } from './util/time.js';
import { Store } from './db/store.js';
import { sync } from './sync/index.js';
import type { Logger } from './util/logger.js';

export interface RunOptions {
  cwd?: string;
  /** Context directory to use instead of ./lab34-health-context. */
  contextPath?: string;
  logger: Logger;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface RunOutcome {
  report: WrittenReport;
  runNumber: number;
  warnings: string[];
  durationSeconds: number;
}

/**
 * Report ids are second-granular, so two runs started within the same second
 * would collide — on the runs table's unique index and on the report
 * directory. Rather than widening the id for everyone, a collision takes the
 * next free suffix.
 */
function uniqueReportId(store: Store, base: string): string {
  if (!store.reportIdExists(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.reportIdExists(candidate)) return candidate;
  }
  throw new HealthError(`Cannot find a free report id for ${base}`);
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * One end-to-end run: read the context, sync, build the report, write it out.
 *
 * The run row is opened before syncing and closed after writing, so a run that
 * dies partway is left marked failed rather than silently counting as history.
 */
export async function run(options: RunOptions): Promise<RunOutcome> {
  const { logger } = options;
  const now = options.now ?? new Date();

  const context = await resolveContext({ cwd: options.cwd, contextPath: options.contextPath });
  logger.step(`context ${context.root}`);

  const config = await loadConfig(context.configPath, options.env);
  logger.debug(`config: ${config.integrations.length} integration(s), ${config.jiraSummaries.length} jira summary/summaries`);

  const db = openDatabase(context.databasePath);
  const store = new Store(db);

  const reportId = uniqueReportId(store, toReportId(now));
  const runId = store.beginRun(reportId, now.toISOString());

  try {
    const result = await sync(config, store, runId, now, logger);
    logger.debug(
      `synced ${result.stats.pullRequestsFetched}/${result.stats.pullRequestsSeen} pull request detail(s), `
      + `${result.stats.pipelines} pipeline(s), ${result.stats.issuesFetched}/${result.stats.issuesSeen} issue changelog(s)`,
    );

    const finishedAt = new Date();
    const document = buildReport({
      config, store, runId, runNumber: runId, reportId,
      startedAt: now, now: finishedAt, sync: result, version: packageVersion(),
    });

    const report = await writeReport(context.reportsDir, document);
    const durationSeconds = Math.max(0, Math.round((finishedAt.getTime() - now.getTime()) / 1000));

    store.finishRun(runId, finishedAt.toISOString(), finishedAt.getTime() - now.getTime(), 'ok');

    const prunedRuns = store.pruneRuns(config.report.retentionRuns);
    const prunedReports = await pruneReports(context.reportsDir, config.report.retentionReports);
    if (prunedRuns > 0 || prunedReports.length > 0) {
      logger.debug(`pruned ${prunedRuns} run(s) and ${prunedReports.length} report director(ies)`);
    }

    return { report, runNumber: runId, warnings: result.warnings, durationSeconds };
  } catch (error) {
    store.finishRun(
      runId, new Date().toISOString(), Date.now() - now.getTime(), 'failed', (error as Error).message,
    );
    throw error;
  } finally {
    db.close();
  }
}
