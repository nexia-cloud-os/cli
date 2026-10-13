import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSubmissions, selectSubmission, formatSubmissions } from '../src/submissions.js';

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
