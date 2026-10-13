import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalLink } from '../src/terminal-link.js';
import { formatSessions } from '../src/dev-sessions.js';

const url = 'https://developers.nexia.to/projects/example/workspace?preview=http%3A%2F%2F127.0.0.1%3A4310';
const tty = { isTTY: true };
const supported = { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' };

test('OSC 8 links retain exact destination and close after the visible label', () => {
  assert.equal(terminalLink(url, 'Open workspace', tty, supported), `\x1b]8;;${url}\x1b\\Open workspace\x1b]8;;\x1b\\`);
  const unknown = terminalLink(url, 'Open workspace', tty, {});
  assert.ok(unknown.includes(`\x1b\\${url}\x1b]8;;`));
});

test('redirected output and unsupported terminal modes retain plain URLs', () => {
  assert.equal(terminalLink(url, 'Open', { isTTY: false }, supported), url);
  for (const env of [{ TERM: 'dumb' }, { CI: 'true' }, { TERM_PROGRAM: 'Apple_Terminal' }]) {
    assert.equal(terminalLink(url, 'Open', tty, env), url);
  }
});

test('link text and destination cannot inject terminal controls', () => {
  const link = terminalLink('https://example.test/\x07\x1b', 'Open\x1b\x07\n', tty, supported);
  assert.equal(link, '\x1b]8;;https://example.test/\x1b\\Open\x1b]8;;\x1b\\');
  for (const invalid of ['javascript:alert(1)', 'not a URL', 'https://user:password@example.test']) {
    assert.ok(!terminalLink(invalid, 'Open', tty, supported).includes('\x1b]8'));
  }
});

test('ps formats workspace links without mutating session data or JSON', () => {
  const sessions = [{ port: 4310, pid: 123, status: 'watching', apps: ['people'], workspace_url: url }];
  const before = JSON.stringify(sessions);
  assert.ok(formatSessions(sessions, tty, supported).includes(terminalLink(url, 'Open workspace', tty, supported)));
  assert.ok(!formatSessions(sessions, { isTTY: false }, supported).includes('\x1b'));
  assert.equal(JSON.stringify(sessions), before);
});
