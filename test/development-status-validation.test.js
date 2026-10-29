import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateExecutionSelection } from '../src/apps.js';

test('batched execution selection retains scope and revision validation', () => {
  const scope = { app_id: randomUUID(), project_id: randomUUID() };
  const selection = { ...scope, sandbox_id: randomUUID(), mode: 'development', revision: 1, stop_pending: false };
  assert.equal(validateExecutionSelection(selection, scope), selection);
  assert.throws(() => validateExecutionSelection({ ...selection, project_id: randomUUID() }, scope));
  assert.throws(() => validateExecutionSelection({ ...selection, revision: -1 }, scope));
  assert.throws(() => validateExecutionSelection(undefined, scope));
});
