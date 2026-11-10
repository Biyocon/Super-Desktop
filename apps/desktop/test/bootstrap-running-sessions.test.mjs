import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { bootstrapRunningSessions } = await import('../src/lib/bootstrap-running-sessions.ts');

test('reload restores host-owned active turns without treating stale history as live', () => {
  assert.deepEqual(bootstrapRunningSessions({}, { child: 'turn' }), { child: true });
  assert.deepEqual(bootstrapRunningSessions({}, undefined), {});
  assert.deepEqual(bootstrapRunningSessions({}, {}), {});
});
test('start and terminal events during bootstrap take precedence over the snapshot', () => {
  const current = { finished: false, newTurn: true };
  assert.deepEqual(bootstrapRunningSessions(current, { finished: 'old', held: 'live' }), { finished: false, newTurn: true, held: true });
  assert.deepEqual(current, { finished: false, newTurn: true });
});
