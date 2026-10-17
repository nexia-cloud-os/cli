import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSubmissions, selectSubmission, formatSubmissions, formatSubmission } from '../src/submissions.js';

test('recent submissions support paging, selection and noninteractive listing without writes', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const project = { id: '11111111-1111-4111-8111-111111111111', name: 'Example' };
  const id = '22222222-2222-4222-8222-222222222222';
  const config = { endpoint: 'https://example.test', token: 'test', project };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ project, page, has_more: page === 1, submissions: [
      { id, app: { name: 'People' }, tag: `v1.0.${page}`, status: 'review_pending', created_at: '2026-10-14T00:00:00Z' },
    ] }), { headers: { 'Content-Type': 'application/json' } });
  };
  let count = 0;
  const selected = await selectSubmission(config, { interactive: true, choice: async (key, title, choices) => {
    assert.match(title, /Example/);
    assert.match(choices[0].label, /People.*v1\.0\./);
    return count++ === 0 ? 'next' : id;
  } });
  assert.equal(selected.id, id);
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '2');
  const listed = await selectSubmission(config, { interactive: false });
  assert.ok(listed.list);
  assert.match(formatSubmissions(listed.list), /nexia submit list --page 2/);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  await assert.rejects(recentSubmissions(config, { page: 0 }), /--page/);
  await assert.rejects(recentSubmissions({ ...config, project: { id: 'another-project' } }), /Invalid submission list/);
});

test('submission receipts distinguish new, reused and older-server acknowledgements', () => {
  const submission = { id: 'receipt-id', tag: 'v1.0.0', status: 'waiting' };
  assert.match(formatSubmission({ submission, submission_reused: true }), /Already submitted.*no new submission/);
  assert.match(formatSubmission({ submission, submission_reused: false }), /Submission received for review/);
  assert.doesNotMatch(formatSubmission({ submission }), /Already submitted|Submission received/);
});

test('submission guidance follows state without suggesting unsafe retries or claiming deployment', () => {
  const result = (status, extra = {}) => formatSubmission({ submission: { id: 'receipt-id', tag: 'v1.0.0', status, ...extra } });
  for (const status of ['waiting', 'queued', 'building', 'running']) {
    assert.match(result(status), /do not submit again/);
    assert.doesNotMatch(result(status), /new version tag|submit retry/);
  }
  assert.match(result('failed', { retryable: true }), /nexia submit retry receipt-id/);
  assert.doesNotMatch(result('failed', { retryable: false }), /nexia submit retry/);
  assert.match(result('needs_review'), /reconcile.*Do not reset/);
  assert.match(result('approved'), /Await administrator publication/);
  assert.match(result('published'), /does not confirm deployment or installation/);
  for (const status of ['rejected', 'cancelled']) assert.match(result(status), /new version tag/);
  assert.match(result('future-state'), /Inspect the current submission/);
});

test('status includes check progress and review notes, with terminal control characters removed', () => {
  const result = { submission: { id: 'receipt-id', tag: 'v1.0.0', status: 'built' },
    build: { review_note: '\u001b[31mFix permissions\u001b[0m' },
    review: { status: 'checks_incomplete', ready_for_human_review: false,
      checks: [{ key: 'app_php_tests', title: 'App PHP tests', status: 'failed' }],
      analysis_progress: { completed: 2, total: 4 } } };
  const output = formatSubmission(result);
  assert.match(output, /App PHP tests: failed/);
  assert.match(output, /Analysis: 2\/4/);
  assert.match(output, /Review note: Fix permissions/);
  assert.doesNotMatch(output, /\u001b/);
  assert.match(output, /Checks are incomplete/);
  result.review.ready_for_human_review = true;
  assert.match(formatSubmission(result), /Await administrator review/);
});


test('preflight retry guidance waits for corrected toolchain and preserves submission identity', () => {
  const submission = { id: 'original-id', tag: 'v1.0.0', status: 'failed', failure: 'test_recipe_mismatch',
    retryable: true, retry_ready: false, retry_blocked_reason: 'artifact_toolchain_not_ready' };
  const blocked = formatSubmission({ submission });
  assert.match(blocked, /stopped before execution/);
  assert.match(blocked, /No App code change or new tag is needed/);
  assert.match(blocked, /correction is pending/);
  assert.doesNotMatch(blocked, /nexia submit retry/);
  assert.match(blocked, /nexia submit status original-id/);
  const ready = formatSubmission({ submission: { ...submission, retry_ready: true, retry_blocked_reason: null } });
  assert.match(ready, /nexia submit retry original-id/);
  assert.match(ready, /no administrator approval required/);
  assert.doesNotMatch(ready, /correction is pending/);
});
test('completed failed checks offer a new immutable attempt only when the server confirms readiness', () => {
  const submission = { id: 'receipt-id', tag: 'v1.0.0', status: 'built', retryable: true, retry_kind: 'toolchain_rebuild', retry_ready: true };
  assert.match(formatSubmission({ submission }), /nexia submit retry receipt-id/);
  assert.match(formatSubmission({ submission }), /previous results are preserved/);
  for (const retry_ready of [false, undefined]) {
    const output = formatSubmission({ submission: { ...submission, retry_ready } });
    assert.match(output, /not ready/);
    assert.doesNotMatch(output, /nexia submit retry/);
  }
});
