import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apportion, buildTimeline } from './timeline.js';
import type { IssueChangeInput } from '../db/types.js';

const LANES = ['To Do', 'In Progress', 'Code Review', 'QA', 'Done'];
const NOW = new Date('2026-08-20T09:14:02Z');

const status = (from: string | null, to: string, at: string): IssueChangeInput =>
  ({ field: 'status', fromValue: from, toValue: to, changedAt: at, author: null });
const assignee = (from: string | null, to: string | null, at: string): IssueChangeInput =>
  ({ field: 'assignee', fromValue: from, toValue: to, changedAt: at, author: null });

test('lane hours always sum to the ticket span', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-08T09:14:02Z', resolvedAt: null, now: NOW,
    currentStatus: 'Code Review', currentAssignee: 'm.dupont', laneOrder: LANES,
    changes: [
      status(null, 'To Do', '2026-08-08T09:14:02Z'),
      status('To Do', 'In Progress', '2026-08-11T09:14:02Z'),
      status('In Progress', 'Code Review', '2026-08-16T09:14:02Z'),
    ],
  });

  assert.equal(timeline.totalHours, 288);
  assert.equal(timeline.lanes.reduce((a, l) => a + l.hours, 0), 288);
  assert.deepEqual(timeline.lanes.map((l) => l.hours), [72, 120, 96, 0, 0]);
  assert.deepEqual(timeline.lanes.map((l) => l.timeDisplay), ['3d', '5d', '4d', '—', '—']);
  // In Progress holds 41% of the span, past the 0.35 default.
  assert.deepEqual(timeline.lanes.map((l) => l.emphasis),
    ['normal', 'heavy', 'normal', 'empty', 'empty']);
});

test('who comes from the assignee in effect during each segment', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-08T09:14:02Z', resolvedAt: null, now: NOW,
    currentStatus: 'Code Review', currentAssignee: 'm.dupont', laneOrder: LANES,
    changes: [
      status(null, 'To Do', '2026-08-08T09:14:02Z'),
      status('To Do', 'In Progress', '2026-08-11T09:14:02Z'),
      assignee(null, 'a.ruiz', '2026-08-11T09:14:02Z'),
      status('In Progress', 'Code Review', '2026-08-16T09:14:02Z'),
      assignee('a.ruiz', 'm.dupont', '2026-08-16T09:14:02Z'),
    ],
  });

  // Nobody held it while it sat in the backlog.
  assert.equal(timeline.lanes[0]?.who, 'unassigned');
  assert.equal(timeline.lanes[1]?.who, 'a.ruiz');
  assert.equal(timeline.lanes[2]?.who, 'm.dupont');
  assert.equal(timeline.lanes[2]?.segments[0]?.title, 'Code Review · 96h · m.dupont');
});

test('revisiting a status produces two segments in one lane', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-14T09:14:02Z', resolvedAt: null, now: NOW,
    currentStatus: 'Code Review', currentAssignee: 'a.ruiz', laneOrder: LANES,
    changes: [
      status(null, 'In Progress', '2026-08-14T09:14:02Z'),
      status('In Progress', 'Code Review', '2026-08-16T09:14:02Z'),
      status('Code Review', 'In Progress', '2026-08-17T09:14:02Z'),
      status('In Progress', 'Code Review', '2026-08-19T09:14:02Z'),
    ],
  });

  const review = timeline.lanes.find((l) => l.status === 'Code Review');
  assert.equal(review?.segments.length, 2);
  assert.deepEqual(review?.segments.map((s) => [s.startHours, s.durationHours]), [[48, 24], [120, 24]]);
  assert.equal(review?.hours, 48);
});

test('an unlisted status folds into the last listed lane it passed through', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-16T09:14:02Z', resolvedAt: null, now: NOW,
    currentStatus: 'In Progress', currentAssignee: null, laneOrder: LANES,
    changes: [
      status(null, 'In Progress', '2026-08-16T09:14:02Z'),
      // "Blocked" is on the board but not in timeline_statuses.
      status('In Progress', 'Blocked', '2026-08-17T09:14:02Z'),
      status('Blocked', 'In Progress', '2026-08-19T09:14:02Z'),
    ],
  });

  assert.deepEqual(timeline.lanes.map((l) => l.status), LANES);
  // The blocked time is attributed to In Progress rather than lost.
  assert.equal(timeline.lanes[1]?.hours, 96);
  assert.equal(timeline.lanes.reduce((a, l) => a + l.hours, 0), timeline.totalHours);
});

test('a ticket with no changelog still renders one lane', () => {
  const timeline = buildTimeline({
    createdAt: '2026-07-17T09:14:02Z', resolvedAt: null, now: NOW,
    currentStatus: 'To Do', currentAssignee: null, changes: [], laneOrder: LANES,
  });

  assert.equal(timeline.totalHours, 816);
  assert.equal(timeline.lanes[0]?.hours, 816);
  assert.equal(timeline.lanes[0]?.emphasis, 'heavy');
  assert.equal(timeline.lanes[0]?.who, 'unassigned');
});

test('a resolved ticket stops at its resolution, not at now', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-13T09:14:02Z', resolvedAt: '2026-08-18T09:14:02Z', now: NOW,
    currentStatus: 'Done', currentAssignee: 'a.ruiz', laneOrder: LANES,
    changes: [status(null, 'In Progress', '2026-08-13T09:14:02Z'), status('In Progress', 'Done', '2026-08-17T09:14:02Z')],
  });

  assert.equal(timeline.totalHours, 120);
  assert.equal(timeline.end, '2026-08-18T09:14:02.000Z');
});

test('a just-created ticket does not divide by zero', () => {
  const timeline = buildTimeline({
    createdAt: '2026-08-20T09:14:00Z', resolvedAt: null, now: NOW,
    currentStatus: 'To Do', currentAssignee: null, changes: [], laneOrder: LANES,
  });
  assert.equal(timeline.totalHours, 1);
  assert.equal(timeline.lanes.reduce((a, l) => a + l.hours, 0), 1);
});

test('apportion distributes whole units without losing any', () => {
  assert.deepEqual(apportion([1, 1, 1], 10), [4, 3, 3]);
  assert.deepEqual(apportion([0, 0], 5), [0, 0]);
  assert.deepEqual(apportion([5, 3, 2], 100), [50, 30, 20]);
  for (const total of [7, 13, 97, 288, 503]) {
    const out = apportion([3, 5, 7, 11], total);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
  }
});
