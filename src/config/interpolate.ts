import { HealthError } from '../util/errors.js';

const PLACEHOLDER = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * An unquoted `{{ env.X }}` is a YAML flow mapping, not a string, and parses
 * to a single-key map whose key is `{ env.X }`. Recognising that shape lets us
 * name the real mistake instead of complaining about a missing field.
 */
const SWALLOWED_KEY = /^\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function swallowedPlaceholder(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const match = SWALLOWED_KEY.exec(keys[0] as string);
  return match && value[keys[0] as string] === null ? match[1] : undefined;
}

/**
 * Replaces "{{ env.NAME }}" with process.env.NAME throughout a parsed config
 * document.
 *
 * Substituting after the YAML is parsed rather than over its raw text means
 * comments never get substituted, and a value can contain quotes, backslashes
 * or newlines without any escaping — it is already a string by the time we
 * touch it, so there is no scalar left to break out of.
 */
export function resolveEnvPlaceholders<T>(document: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing = new Set<string>();
  const unquoted: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    const swallowed = swallowedPlaceholder(value);
    if (swallowed) {
      unquoted.push(`${path || 'value'} ({{ env.${swallowed} }})`);
      return '';
    }

    if (typeof value === 'string') {
      return value.replace(PLACEHOLDER, (_match, name: string) => {
        const resolved = env[name];
        if (resolved === undefined || resolved === '') {
          missing.add(name);
          return '';
        }
        return resolved;
      });
    }

    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`));

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = walk(item, path ? `${path}.${key}` : key);
      }
      return out;
    }

    return value;
  };

  const result = walk(document, '') as T;

  if (unquoted.length > 0) {
    throw new HealthError(
      `config.yaml has ${unquoted.length === 1 ? 'an unquoted placeholder' : 'unquoted placeholders'}: ${unquoted.join(', ')}`,
      'Wrap them in quotes — an unquoted {{ ... }} is a YAML mapping, not a string. Write token: "{{ env.NAME }}".',
    );
  }

  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new HealthError(
      `config.yaml references ${names.length === 1 ? 'an environment variable' : 'environment variables'} that ${names.length === 1 ? 'is' : 'are'} not set: ${names.join(', ')}`,
      'Export the variable, or add it to the environment the CLI runs in. Values are never printed back.',
    );
  }

  return result;
}

/** Names every "{{ env.X }}" a parsed config refers to, without substituting. */
export function referencedEnvNames(document: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    const swallowed = swallowedPlaceholder(value);
    if (swallowed) { names.add(swallowed); return; }
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1] as string);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (isPlainObject(value)) Object.values(value).forEach(walk);
  };
  walk(document);
  return [...names].sort();
}
