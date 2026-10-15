import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInput, Cancelled } from '../src/input.js';
import { helpText, commands } from '../src/commands.js';
import { paint, fit } from '../src/terminal.js';

test('help includes every command in task groups and color respects plain output', () => {
  const help = helpText();
  for (const name of Object.keys(commands)) assert.ok(help.includes(name));
  assert.match(help, /Start & connect/);
  assert.match(help, /Submit & review/);
  assert.equal(paint('Title', 'title', {}, {}), 'Title');
  assert.equal(paint('Title', 'title', { isTTY: true }, { NO_COLOR: '' }), 'Title');
  assert.equal(paint('Title', 'title', { isTTY: true }, { TERM: 'dumb' }), 'Title');
  assert.match(paint('Title', 'title', { isTTY: true }, {}), /\x1b\[1m/);
  assert.match(paint('Done', 'success', { isTTY: true }, {}), /\x1b\[32m/);
  assert.match(paint('Failed', 'error', { isTTY: true }, {}), /\x1b\[31m/);
  assert.equal(fit('ab한글cd', 6), 'ab한');
});

test('single selection handles arrows, safe default, cancellation and restores the terminal', async t => {
  const term = process.env.TERM;
  process.env.TERM = 'xterm';
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; });
  for (const action of ['select', 'cancel', 'end']) {
    const stdin = new PassThrough();
    stdin.isTTY = true; stdin.isRaw = false;
    stdin.setRawMode = value => { stdin.isRaw = value; };
    let rendered = '';
    const stdout = { isTTY: true, rows: 8, columns: 40, write: text => { rendered += text; } };
    const input = createInput({}, { input: stdin, output: stdout });
    const result = input.choice('confirm', 'Choose', [{ value: 'yes', label: 'Apply' }, { value: 'no', label: 'Cancel' }], 'no');
    if (action === 'select') {
      stdin.emit('keypress', '', { name: 'up' });
      stdin.emit('keypress', '', { name: 'return' });
      assert.equal(await result, 'yes');
    } else {
      if (action === 'end') stdin.emit('end'); else stdin.emit('keypress', '', { name: 'escape' });
      await assert.rejects(result, error => error instanceof Cancelled);
    }
    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.listenerCount('keypress'), 0);
    assert.equal(stdin.listenerCount('end'), 0);
    assert.match(rendered, /Cancel/);
    input.close(); stdin.destroy();
  }
});
