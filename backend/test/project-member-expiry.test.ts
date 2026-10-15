import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProjectMemberExpiryDate } from '../src/ui/project-write.server';

test('project member expiration preserves omitted values and accepts changes or clearing', () => {
  assert.equal(resolveProjectMemberExpiryDate(undefined, '2030-01-01'), '2030-01-01');
  assert.equal(resolveProjectMemberExpiryDate('', '2030-01-01'), null);
  assert.equal(resolveProjectMemberExpiryDate(' 2032-02-29 ', null), '2032-02-29');
});

test('project member expiration rejects invalid calendar dates', () => {
  for (const date of ['2031-02-29', '2031-13-01', '2031-02-30', 'tomorrow']) {
    assert.throws(() => resolveProjectMemberExpiryDate(date, null), (error: unknown) =>
      (error as { init?: { status?: number } }).init?.status === 400,
    );
  }
});
