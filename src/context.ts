import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { HealthError } from './util/errors.js';

export const CONTEXT_DIR_NAME = 'lab34-health-context';

export interface Context {
  /** Absolute path to the lab34-health-context directory. */
  root: string;
  configPath: string;
  databasePath: string;
  reportsDir: string;
}

export interface ResolveContextOptions {
  /** Directory to look for the context directory in, and to resolve `contextPath` against. */
  cwd?: string;
  /** The context directory itself, when it does not sit in `cwd` under its conventional name. */
  contextPath?: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the context directory: `contextPath` when given, otherwise
 * `CONTEXT_DIR_NAME` inside `cwd`.
 *
 * The `cwd` form deliberately does not walk up the tree: which directory you
 * run from decides which team you report on, and silently reporting on a
 * parent's context because you were one directory deep would be a bad
 * surprise. `contextPath` is the escape hatch for a context that lives
 * somewhere else entirely — it is used as the directory itself, not as a
 * parent to look inside, and its name does not matter.
 */
export async function resolveContext(options: ResolveContextOptions = {}): Promise<Context> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicit = options.contextPath !== undefined;
  const root = explicit ? resolve(cwd, options.contextPath as string) : join(cwd, CONTEXT_DIR_NAME);

  if (!(await isDirectory(root))) {
    throw new HealthError(
      explicit ? `No context directory at ${root}` : `No ${CONTEXT_DIR_NAME} directory in ${cwd}`,
      explicit
        ? 'Point --context-path at a directory holding a config.yaml.'
        : `Create it with a config.yaml inside, then run lab34-health from ${cwd}.`,
    );
  }

  return {
    root,
    configPath: join(root, 'config.yaml'),
    databasePath: join(root, 'database.sql'),
    reportsDir: join(root, 'reports'),
  };
}
