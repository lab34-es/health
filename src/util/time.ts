export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function toIso(date: Date | string | number): string {
  return new Date(date).toISOString();
}

export function hoursBetween(from: Date | string, to: Date | string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / HOUR_MS);
}

/** Precise pipeline durations: "11m 40s", "2m 04s", "1h 04m 09s". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Coarse durations for headline figures: "12m", "1h 5m", "45s". */
export function formatDurationCoarse(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * "3d ago", "19h ago", "just now".
 *
 * Days take over at 24 hours and are rounded rather than floored. Carrying
 * hours further would put "44h ago" next to "2d ago" in the same commit list,
 * where the two formats read as different scales rather than nearby times.
 */
export function formatRelative(from: Date | string, now: Date | string = new Date()): string {
  const ms = new Date(now).getTime() - new Date(from).getTime();
  if (ms < 0) return 'in the future';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ms / DAY_MS);
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** Timeline lane totals: hours below a day, whole days above. */
export function formatLaneTime(hours: number): string {
  if (hours <= 0) return '—';
  return hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
}

function parts(date: Date | string, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(date))) out[p.type] = p.value;
  return out;
}

/** "2026-08-17 12:14" in the report's timezone. */
export function formatDateTime(date: Date | string, timeZone: string): string {
  const p = parts(date, timeZone);
  // Intl renders midnight as "24" under hour12:false in some ICU versions.
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

/** "2026-08-17" in the report's timezone. */
export function formatDate(date: Date | string, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-08-20 09:14 UTC", for the header meta line. */
export function formatUtcStamp(date: Date | string): string {
  return `${formatDateTime(date, 'UTC')} UTC`;
}

/** Directory-safe run id: "2026-08-20T09-14-02Z". */
export function reportId(date: Date | string): string {
  return toIso(date).replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** Validates a timezone name early, so a typo fails at config load. */
export function assertTimeZone(tz: string): void {
  new Intl.DateTimeFormat('en-GB', { timeZone: tz });
}
