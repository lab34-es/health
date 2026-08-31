import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstReviewFrom, pipelineOutcome, reviewersFrom, stepOutcome } from './bitbucket.js';
import { statusCategory } from './jira.js';

test('pipeline outcomes map Bitbucket states onto the report vocabulary', () => {
  assert.equal(pipelineOutcome({ name: 'COMPLETED', result: { name: 'SUCCESSFUL' } }), 'PASSED');
  assert.equal(pipelineOutcome({ name: 'COMPLETED', result: { name: 'FAILED' } }), 'FAILED');
  assert.equal(pipelineOutcome({ name: 'COMPLETED', result: { name: 'ERROR' } }), 'FAILED');
  assert.equal(pipelineOutcome({ name: 'COMPLETED', result: { name: 'STOPPED' } }), 'STOPPED');
  assert.equal(pipelineOutcome({ name: 'IN_PROGRESS' }), 'RUNNING');
  assert.equal(pipelineOutcome(undefined), 'RUNNING');
});

test('step outcomes distinguish failed from never-ran', () => {
  assert.equal(stepOutcome({ result: { name: 'SUCCESSFUL' } }), 'passed');
  assert.equal(stepOutcome({ result: { name: 'FAILED' } }), 'failed');
  // A stopped or pending step never ran; grouping it with skipped avoids
  // reporting a failure the team did not cause.
  assert.equal(stepOutcome({ result: { name: 'STOPPED' } }), 'skipped');
  assert.equal(stepOutcome({ name: 'NOT_RUN' }), 'skipped');
  assert.equal(stepOutcome({ name: 'IN_PROGRESS' }), 'running');
});

test('first review is the earliest approval, change request or comment', () => {
  const activity = [
    { comment: { created_on: '2026-08-19T09:41:00+00:00' } },
    { approval: { date: '2026-08-18T08:02:00+00:00' } },
    { update: { date: '2026-08-17T10:14:00+00:00' } },
    { changes_requested: { date: '2026-08-18T22:00:00+00:00' } },
  ];
  // The update at 10:14 is the author pushing, not a review, so it is ignored.
  assert.equal(firstReviewFrom(activity), '2026-08-18T08:02:00.000Z');
  assert.equal(firstReviewFrom([]), null);
});

test('reviewers keep their own state, and non-reviewer participants are dropped', () => {
  const reviewers = reviewersFrom({
    id: 1, title: 't', state: 'OPEN', created_on: '2026-08-17T10:00:00Z', updated_on: '2026-08-19T10:00:00Z',
    reviewers: [{ nickname: 'm.dupont' }, { nickname: 's.peeters' }, { nickname: 'j.claes' }],
    participants: [
      { user: { nickname: 'm.dupont' }, state: 'approved', approved: true, participated_on: '2026-08-18T08:02:00Z' },
      { user: { nickname: 's.peeters' }, state: 'changes_requested', participated_on: '2026-08-19T09:41:00Z' },
      // The author drifts into participants by commenting; they are not a reviewer.
      { user: { nickname: 'a.ruiz' }, state: null, participated_on: '2026-08-17T10:20:00Z' },
    ],
  });

  assert.deepEqual(reviewers.map((r) => [r.userName, r.state]), [
    ['j.claes', 'pending'],
    ['m.dupont', 'approved'],
    ['s.peeters', 'changes_requested'],
  ]);
});

test('jira status categories are renamed to the report vocabulary', () => {
  assert.equal(statusCategory('new'), 'to_do');
  assert.equal(statusCategory('indeterminate'), 'in_progress');
  assert.equal(statusCategory('done'), 'done');
  assert.equal(statusCategory(undefined), null);
});
