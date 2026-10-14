import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCommand } from '../src/commands.js';
import { formatDocs } from '../src/docs.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = promisify(execFile);

test('docs commands use explicit arguments and reject unknown subcommands/options', () => {
  assert.equal(parseCommand(['docs']).name, 'docs');
  assert.equal(parseCommand(['docs', 'search', '리소스 권한', '--json']).argument, '리소스 권한');
  assert.equal(parseCommand(['docs', 'read', 'app-sdk-sdk-contracts', '--locale', 'en']).options.locale, 'en');
  assert.throws(() => parseCommand(['docs', 'update']), /Unknown command/);
  assert.throws(() => parseCommand(['docs', '--yes']), /not supported/);
  assert.match(formatDocs({ total: 0, documents: [] }), /No matching documents/);
});

test('public docs work outside a project without touching credentials or instructions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexia-docs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'connection.json'), 'not valid JSON: must never be read');
  await writeFile(path.join(directory, 'AGENTS.md'), 'Developer-owned instructions\n');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const url = new URL(request.url, 'http://localhost');
    const locale = url.searchParams.get('locale');
    const summary = { id: 'app-sdk-sdk-contracts', title: 'PHP SDK', description: 'Public contracts', url: 'https://developers.nexia.to/docs/app-sdk-sdk-contracts', locale, source_locale: 'en', locale_status: locale === 'en' ? 'authored' : 'fallback' };
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/missing')) { response.writeHead(404); response.end(JSON.stringify({ message: 'Published document not found.' })); }
    else if (url.pathname.endsWith('/malformed')) response.end('{}');
    else if (url.pathname.endsWith('/redirect')) { response.writeHead(302, { Location: '/login' }); response.end(); }
    else if (url.pathname.endsWith('/limited')) { response.writeHead(429); response.end(JSON.stringify({ message: 'Too Many Attempts.' })); }
    else if (url.searchParams.has('q')) response.end(JSON.stringify({ query: url.searchParams.get('q'), locale, total: 1, documents: [summary] }));
    else response.end(JSON.stringify({ ...summary, content: '# Contract\n\nExample body.' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { cwd: directory, env: { ...process.env, NEXIA_ENDPOINT: `http://127.0.0.1:${server.address().port}`, NEXIA_CONFIG_HOME: directory, LC_ALL: 'en_US.UTF-8' } };

  const searched = await run(process.execPath, [cli, 'docs', 'search', '리소스 권한', '--locale', 'ko', '--json'], options);
  assert.equal(JSON.parse(searched.stdout).query, '리소스 권한');
  assert.equal(searched.stderr, '');
  assert.equal(new URL(requests[0].url, 'http://localhost').searchParams.get('locale'), 'ko');
  const read = await run(process.execPath, [cli, 'docs', 'read', 'app-sdk-sdk-contracts', '--locale', 'ko'], options);
  assert.match(read.stdout, /# Contract/);
  assert.match(read.stdout, /fallback for ko/);
  assert.match(read.stdout, /Source: https:\/\/developers.nexia.to/);
  await run(process.execPath, [cli, 'docs', '--json'], options);
  assert.match(requests.at(-1).url, /\/docs\/getting-started-agent-assisted-development\?locale=en/);
  assert.ok(requests.every(request => request.authorization === undefined));

  for (const id of ['missing', 'malformed', 'redirect', 'limited']) {
    await assert.rejects(run(process.execPath, [cli, 'docs', 'read', id, '--json'], options), error => {
      assert.ok(JSON.parse(error.stdout).error.message);
      assert.equal(error.stderr, '');
      return true;
    });
  }
  const count = requests.length;
  for (const args of [['search'], ['read', '../AGENTS.md'], ['search', 'x', '--locale', 'fr'], ['search', ' '.repeat(3)]]) {
    await assert.rejects(run(process.execPath, [cli, 'docs', ...args, '--json'], options), error => JSON.parse(error.stdout).error.code === 'INVALID_INPUT');
  }
  assert.equal(requests.length, count);
  assert.equal(await readFile(path.join(directory, 'AGENTS.md'), 'utf8'), 'Developer-owned instructions\n');
  assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), 'not valid JSON: must never be read');
});
