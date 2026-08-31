import { HealthError } from '../util/errors.js';

/** Palette names accepted by `age_indicators[].color`. */
export const NAMED_COLORS: Record<string, string> = {
  green: '#3E7C4F',
  yellow: '#B68235',
  amber: '#B68235',
  red: '#B3402F',
  grey: '#C9C6C2',
  gray: '#C9C6C2',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function resolveColor(value: string, where: string): string {
  const trimmed = value.trim();
  if (HEX.test(trimmed)) return trimmed.toUpperCase();
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;
  throw new HealthError(
    `${where}: "${value}" is not a colour`,
    `Use #RRGGBB or one of: ${Object.keys(NAMED_COLORS).join(', ')}.`,
  );
}

const COMPARISON = /^(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)$/;
const RANGE = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/;

/**
 * Parses an `hours` expression into a predicate.
 *
 * Accepts "< 24", "<= 24", "> 48", ">= 48", "= 0" and "24 - 48" (inclusive on
 * both ends). Indicators are evaluated in configured order and the first match
 * wins, so overlapping rules are a deliberate way to express "everything else".
 */
export function parseHoursRule(expression: string, where: string): (hours: number) => boolean {
  const rule = String(expression).trim();

  const comparison = COMPARISON.exec(rule);
  if (comparison) {
    const operator = comparison[1] as string;
    const bound = Number(comparison[2]);
    switch (operator) {
      case '<': return (h) => h < bound;
      case '<=': return (h) => h <= bound;
      case '>': return (h) => h > bound;
      case '>=': return (h) => h >= bound;
      default: return (h) => h === bound;
    }
  }

  const range = RANGE.exec(rule);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low > high) {
      throw new HealthError(`${where}: range "${rule}" starts above where it ends`);
    }
    return (h) => h >= low && h <= high;
  }

  throw new HealthError(
    `${where}: "${expression}" is not an hours rule`,
    'Use "< 24", "<= 24", "> 48", ">= 48", "= 0" or a range like "24 - 48".',
  );
}
