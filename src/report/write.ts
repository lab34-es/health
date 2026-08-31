import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderHtml } from './html.js';
import { toYaml } from './yaml.js';
import type { ReportDocument } from './model.js';

export interface WrittenReport {
  dir: string;
  yamlPath: string;
  htmlPath: string;
}

/**
 * Writes reports/<id>/index.yaml and index.html.
 *
 * The YAML is serialised once and both files get the same text, so the copy
 * embedded in the HTML and the file beside it can never disagree.
 */
export async function writeReport(
  reportsDir: string, document: ReportDocument,
): Promise<WrittenReport> {
  const dir = join(reportsDir, document.report.id);
  await mkdir(dir, { recursive: true });

  const yaml = toYaml(document);
  const yamlPath = join(dir, 'index.yaml');
  const htmlPath = join(dir, 'index.html');

  await writeFile(yamlPath, yaml, 'utf8');
  await writeFile(htmlPath, renderHtml(document, yaml), 'utf8');

  return { dir, yamlPath, htmlPath };
}

/** Keeps the most recent `keep` report directories; 0 keeps everything. */
export async function pruneReports(reportsDir: string, keep: number): Promise<string[]> {
  if (keep <= 0) return [];

  let entries: string[];
  try {
    entries = (await readdir(reportsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const doomed = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of doomed) await rm(join(reportsDir, name), { recursive: true, force: true });
  return doomed;
}
