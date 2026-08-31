import { HealthError } from './errors.js';

export type Raw = Record<string, unknown>;

export function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, where: string): Raw {
  if (!isRecord(value)) throw new HealthError(`${where} must be a mapping`);
  return value;
}

export function requireString(value: unknown, where: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  throw new HealthError(`${where} is required and must be a non-empty string`);
}

export function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, where);
}

export function optionalNumber(value: unknown, where: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new HealthError(`${where} must be a number`);
  return n;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true';
}

export function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new HealthError(`${where} must be a list`);
  return value;
}

export function optionalArray(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  return requireArray(value, where);
}

export function requireOneOf<T extends string>(
  value: unknown, allowed: readonly T[], where: string, fallback?: T,
): T {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  const s = String(value ?? '').trim();
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  throw new HealthError(`${where} must be one of: ${allowed.join(', ')}`, `Got "${s}".`);
}
