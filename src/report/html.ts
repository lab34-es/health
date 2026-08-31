import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HealthError } from '../util/errors.js';
import type { ReportDocument } from './model.js';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));

const FONTS = 'https://fonts.googleapis.com/css2'
  + '?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap';

function asset(name: string): string {
  return readFileSync(new URL(name, `file://${ASSETS}`), 'utf8');
}

/**
 * The browser build of js-yaml, inlined so the report parses its own YAML with
 * no network access. It is a declared dependency rather than a vendored copy,
 * so it stays patchable through npm.
 */
function yamlParser(): string {
  const require = createRequire(import.meta.url);
  try {
    // js-yaml's "exports" map blocks a deep import of dist/, but exports its
    // own package.json — resolving that gives a package root to read from,
    // which also works under pnpm's non-flat layout.
    const manifest = require.resolve('js-yaml/package.json');
    return readFileSync(join(dirname(manifest), 'dist', 'js-yaml.min.js'), 'utf8');
  } catch {
    throw new HealthError(
      'The js-yaml browser bundle could not be found',
      'Reinstall dependencies: the report embeds it so it can parse its own YAML offline.',
    );
  }
}

/**
 * Embeds YAML text inside a <script> block.
 *
 * A literal "</script" in any value would close the block early, so that one
 * sequence is escaped; the renderer reverses it before parsing. Nothing else
 * is altered, which keeps the embedded copy readable as the YAML it is.
 */
export function embedYaml(yaml: string): string {
  return yaml.replace(/<\/(script)/gi, '<\\/$1');
}

export function unembedYaml(embedded: string): string {
  return embedded.replace(/<\\\/(script)/gi, '</$1');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the standalone report.
 *
 * The page carries its own stylesheet, its own YAML parser and a verbatim copy
 * of index.yaml, and builds every section from that YAML at load time. It has
 * no build step and no runtime dependencies, so it survives being emailed
 * around or dropped on a SharePoint site — the two places these reports
 * actually get read.
 */
export function renderHtml(document: ReportDocument, yaml: string): string {
  const meta = document.report;
  const title = meta.client_label ? `${meta.client_label} — ${meta.title}` : meta.title;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="generator" content="${escapeHtml(`${meta.generator.name} ${meta.generator.version}`)}">
<meta name="description" content="${escapeHtml(`${meta.title} report, run #${meta.run.number}, generated ${meta.generated_at}`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
${asset('report.css')}
</style>
</head>
<body>
<div id="report"></div>

<!-- The report's data. Everything above is layout; everything shown comes from
     here. Edit a value and reload to change the report. A verbatim copy is
     written alongside this file as index.yaml. -->
<script type="application/yaml" id="report-data">
${embedYaml(yaml)}
</script>

<script>
${yamlParser()}
</script>

<script>
${asset('renderer.js')}
</script>
</body>
</html>
`;
}
