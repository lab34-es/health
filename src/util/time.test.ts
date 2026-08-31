import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatDate, formatDateTime, formatDuration, formatDurationCoarse,
  formatLaneTime, formatRelative, formatUtcStamp, hoursBetween, reportId,
} from './time.js';

const NOW = '2026-08-20T09:14:02Z';

test('durations read precisely for pipelines and coarsely for headlines', () => {
  assert.equal(formatDuration(700), '11m 40s');
  assert.equal(formatDuration(542), '9m 02s');
  assert.equal(formatDuration(124), '2m 04s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(3849), '1h 04m 09s');
  assert.equal(formatDurationCoarse(720), '12m');
  assert.equal(formatDurationCoarse(3900), '1h 5m');
  assert.equal(formatDurationCoarse(45), '45s');
});

test('relative times switch to days at 24 hours and round', () => {
  assert.equal(formatRelative('2026-08-20T09:13:30Z', NOW), 'just now');
  assert.equal(formatRelative('2026-08-20T08:44:02Z', NOW), '30m ago');
  assert.equal(formatRelative('2026-08-19T14:14:02Z', NOW), '19h ago');
  // 44 hours reads as 2d rather than 44h, so a commit list stays on one scale.
  assert.equal(formatRelative('2026-08-18T13:10:02Z', NOW), '2d ago');
  assert.equal(formatRelative('2026-08-17T10:20:02Z', NOW), '3d ago');
  assert.equal(formatRelative('2026-08-21T09:14:02Z', NOW), 'in the future');
});

test('lane times use hours below a day and whole days above', () => {
  assert.equal(formatLaneTime(0), '—');
  assert.equal(formatLaneTime(19), '19h');
  assert.equal(formatLaneTime(72), '3d');
  assert.equal(formatLaneTime(816), '34d');
});

test('timestamps format in the report timezone', () => {
  // 09:14 UTC is 11:14 in Brussels during summer time.
  assert.equal(formatDateTime(NOW, 'Europe/Brussels'), '2026-08-20 11:14');
  assert.equal(formatDateTime(NOW, 'UTC'), '2026-08-20 09:14');
  assert.equal(formatUtcStamp(NOW), '2026-08-20 09:14 UTC');
  assert.equal(formatDate(NOW, 'Europe/Brussels'), '2026-08-20');
  // Midnight must not render as hour 24.
  assert.equal(formatDateTime('2026-08-20T00:30:00Z', 'UTC'), '2026-08-20 00:30');
});

test('report ids are directory-safe and hours are rounded', () => {
  assert.equal(reportId(NOW), '2026-08-20T09-14-02Z');
  assert.equal(hoursBetween('2026-08-17T10:14:02Z', NOW), 71);
});
