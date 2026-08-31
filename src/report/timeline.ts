import { formatLaneTime, HOUR_MS } from '../util/time.js';
import type { IssueChangeInput } from '../db/types.js';

export interface TimelineSegment {
  startHours: number;
  durationHours: number;
  who: string;
  enteredAt: string;
  leftAt: string;
  title: string;
}

export interface TimelineLane {
  status: string;
  hours: number;
  timeDisplay: string;
  share: number;
  emphasis: 'normal' | 'heavy' | 'empty';
  who: string;
  segments: TimelineSegment[];
}

export interface Timeline {
  start: string;
  end: string;
  totalHours: number;
  lanes: TimelineLane[];
}

export interface TimelineInput {
  createdAt: string;
  resolvedAt: string | null;
  now: Date;
  currentStatus: string;
  currentAssignee: string | null;
  changes: IssueChangeInput[];
  laneOrder: string[];
  heavyShare?: number;
  unassignedLabel?: string;
}

interface RawSegment { status: string; from: number; to: number }

/**
 * Turns an issue's changelog into the lanes the report draws.
 *
 * A status the board reports but config.yaml does not list is folded into the
 * most recent listed lane the issue passed through, so a board with extra
 * columns still produces the configured number of lanes instead of an
 * unbounded one. Time is never dropped: every hour of the issue's life lands
 * in exactly one lane, and the lane totals sum to the span.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const {
    createdAt, resolvedAt, now, currentStatus, currentAssignee, changes,
    laneOrder, heavyShare = 0.35, unassignedLabel = 'unassigned',
  } = input;

  const startMs = new Date(createdAt).getTime();
  const endMs = Math.max(startMs + HOUR_MS, new Date(resolvedAt ?? now).getTime());
  const spanMs = endMs - startMs;

  const statusChanges = changes
    .filter((c) => c.field === 'status' && c.toValue)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  const assigneeChanges = changes
    .filter((c) => c.field === 'assignee')
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  // Who held the ticket at a moment. Before the first recorded handover the
  // holder is whoever that handover took it from — which is legitimately null
  // for a ticket that started unassigned, so the "no history at all" fallback
  // to the current assignee has to be a length check rather than a ?? on a
  // value that is meaningfully null.
  const initialAssignee = assigneeChanges.length > 0
    ? (assigneeChanges[0] as IssueChangeInput).fromValue
    : currentAssignee;
  const assigneeAt = (atMs: number): string => {
    let holder = initialAssignee;
    for (const change of assigneeChanges) {
      if (new Date(change.changedAt).getTime() > atMs) break;
      holder = change.toValue;
    }
    return holder ?? unassignedLabel;
  };

  // The issue sits in its first status from creation until the first change.
  const raw: RawSegment[] = [];
  let cursor = startMs;
  let status = statusChanges[0]?.fromValue ?? currentStatus;

  for (const change of statusChanges) {
    const at = Math.min(Math.max(new Date(change.changedAt).getTime(), startMs), endMs);
    if (at > cursor) raw.push({ status, from: cursor, to: at });
    status = change.toValue as string;
    cursor = at;
  }
  if (endMs > cursor) raw.push({ status, from: cursor, to: endMs });

  // Fold unlisted statuses into the last listed lane already visited.
  const listed = new Set(laneOrder);
  let lastListed = laneOrder[0] ?? currentStatus;
  const byLane = new Map<string, RawSegment[]>(laneOrder.map((lane) => [lane, []]));

  for (const segment of raw) {
    if (listed.has(segment.status)) lastListed = segment.status;
    const lane = listed.has(segment.status) ? segment.status : lastListed;
    byLane.get(lane)?.push(segment);
  }

  const totalHours = Math.max(1, Math.round(spanMs / HOUR_MS));
  const laneMs = laneOrder.map((lane) =>
    (byLane.get(lane) ?? []).reduce((sum, s) => sum + (s.to - s.from), 0));
  const laneHours = apportion(laneMs, totalHours);

  const lanes: TimelineLane[] = laneOrder.map((lane, index) => {
    const segments = byLane.get(lane) ?? [];
    const hours = laneHours[index] as number;
    const share = totalHours > 0 ? hours / totalHours : 0;
    const people = [...new Set(segments.map((s) => assigneeAt(s.from)))];

    return {
      status: lane,
      hours,
      timeDisplay: formatLaneTime(hours),
      share: Number(share.toFixed(4)),
      emphasis: hours === 0 ? 'empty' : share > heavyShare ? 'heavy' : 'normal',
      who: people.join(', '),
      segments: segments.map((s) => {
        const who = assigneeAt(s.from);
        const durationHours = Math.max(1, Math.round((s.to - s.from) / HOUR_MS));
        return {
          startHours: Math.round((s.from - startMs) / HOUR_MS),
          durationHours,
          who,
          enteredAt: new Date(s.from).toISOString(),
          leftAt: new Date(s.to).toISOString(),
          title: `${lane} · ${durationHours}h · ${who}`,
        };
      }),
    };
  });

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    totalHours,
    lanes,
  };
}

/**
 * Distributes `total` whole hours across `weights` by largest remainder.
 *
 * Rounding each lane independently would let the lanes sum to something other
 * than the ticket's span, which shows up in the report as a timeline whose
 * parts do not add up to its own total.
 */
export function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] = (floors[index] as number) + 1;
    remainder -= 1;
  }
  return floors;
}
