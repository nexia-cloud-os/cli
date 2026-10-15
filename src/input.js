import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { InputError } from './commands.js';
import { paint, fit, plain } from './terminal.js';
export class Cancelled extends Error { constructor() { super('Cancelled'); this.code = 'CANCELLED'; this.exitCode = 130; } }
export const language = 'en';
export const message = en => en;
export function createInput(options = {}, { input = process.stdin, output = process.stderr, ask } = {}) {
  const interactive = !options['no-interactive'] && !options.json && Boolean(input.isTTY && output.isTTY);
  let reader, closed = false;
  async function question(label) {
    if (ask) return ask(label);
    if (!reader) {
      reader = createInterface({ input, output });
      reader.on('SIGINT', () => reader.close());
      reader.on('close', () => { closed = true; });
    }
    if (closed) throw new Cancelled();
    // Closing readline does not resolve an outstanding question by itself.
    const controller = new AbortController(), onClose = () => controller.abort();
    reader.once('close', onClose);
    try { return await reader.question(label, { signal: controller.signal }); }
    catch (error) { if (error.name === 'AbortError') throw new Cancelled(); throw error; }
    finally { reader.removeListener('close', onClose); }
  }
  async function text(key, label, { value = options[key], defaultValue = '', required = false, validate = () => true, hint = `--${key}` } = {}) {
    if (value !== undefined) {
      if ((required && !String(value).trim()) || (String(value) !== '' && !validate(String(value)))) throw new InputError(`${label}: ${message('invalid value', '잘못된 값')} (${hint}).`);
      return value;
    }
    if (!interactive) {
      if (required && !defaultValue) throw new InputError(`${label}: ${message('required; provide', '필수입니다:')} ${hint}.`);
      if (defaultValue !== '' && !validate(String(defaultValue))) throw new InputError(`Invalid default: ${key}`);
      return defaultValue;
    }
    while (true) {
      const answer = (await question(`${label}${defaultValue !== '' ? ` [${defaultValue}]` : ''}\n› `)).trim() || defaultValue;
      if ((!required || answer !== '') && (answer === '' || validate(String(answer)))) return answer;
      output.write(message('Enter a valid value.\n', '올바른 값을 입력하세요.\n'));
    }
  }
  async function choice(key, label, choices, defaultValue, { hint = `--${key}` } = {}) {
    const values = choices.map(item => typeof item === 'string' ? item : item.value);
    const supplied = options[key];
    if (supplied !== undefined) {
      if (!values.includes(supplied)) throw new InputError(`--${key}: ${values.join(', ')}`);
      return supplied;
    }
    if (!interactive) {
      if (defaultValue !== undefined) return defaultValue;
      throw new InputError(`${label}: ${message('specify', '지정하세요:')} ${hint} (${values.join(', ')}).`);
    }
    if (!ask && typeof input.setRawMode === 'function' && process.env.TERM !== 'dumb') {
      if (!choices.length) throw new InputError(message('No available choices.', '선택할 항목이 없습니다.'));
      reader?.close(); reader = undefined; closed = false;
      let cursor = Math.max(0, values.indexOf(defaultValue)), lines = 0, finished = false;
      const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
      const labels = choices.map(item => plain(typeof item === 'string' ? item : item.label));
      output.write(`${paint(label, 'title', output)}\n${paint(message('↑/↓ move · Enter select · Esc cancel', '↑/↓ 이동 · Enter 선택 · Esc 취소'), 'muted', output)}\n`);
      const render = () => {
        if (lines) output.write(`\x1b[${lines}A`);
        const count = Math.min(choices.length, Math.max(1, (output.rows || 24) - 5));
        const start = Math.min(Math.max(0, cursor - count + 1), choices.length - count);
        for (let i = start; i < start + count; i++) {
          const row = fit(`${i === cursor ? '›' : ' '} ${labels[i]}`, output.columns || 100);
          output.write(`\r\x1b[2K${paint(row, i === cursor ? 'accent' : 'muted', output)}\n`);
        }
        lines = count;
      };
      emitKeypressEvents(input);
      return new Promise((resolve, reject) => {
        const finish = error => {
          if (finished) return;
          finished = true;
          input.removeListener('keypress', onKey);
          input.removeListener('end', onEnd);
          input.removeListener('error', onError);
          input.setRawMode(wasRaw);
          if (!wasFlowing) input.pause();
          output.write(`${error ? message('Cancelled', '취소됨') : paint(`✓ ${labels[cursor]}`, 'success', output)}\n`);
          if (error) reject(error); else resolve(values[cursor]);
        };
        const onEnd = () => finish(new Cancelled());
        const onError = error => finish(error);
        const onKey = (_, key = {}) => {
          if (key.name === 'escape' || key.ctrl && ['c', 'd'].includes(key.name)) return onEnd();
          if (key.name === 'return') return finish();
          if (key.name === 'up') cursor = (cursor + values.length - 1) % values.length;
          else if (key.name === 'down') cursor = (cursor + 1) % values.length;
          else return;
          render();
        };
        input.on('keypress', onKey); input.once('end', onEnd); input.once('error', onError);
        input.setRawMode(true); input.resume(); render();
      });
    }
    const labels = choices.map((item, i) => `  ${i + 1}. ${typeof item === 'string' ? item : item.label}`).join('\n');
    const answer = await text(key, `${label}\n${labels}`, { defaultValue: defaultValue ?? '', required: true, validate: value => values.includes(value) || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= values.length) });
    return values.includes(answer) ? answer : values[Number(answer) - 1];
  }
  async function multiChoice(label, choices, { max, initial = [], configure = false, configKeys = [], configAll = false, configError = '', saving = false }) {
    if (!interactive) throw new InputError('Repeat --app to select Apps.');
    const selected = new Set(initial === null ? [] : initial);
    const total = choices.length + 1 + Number(configure);
    const saved = new Set(configKeys);
    const effective = () => all ? choices.map(item => item.value) : [...new Set([...selected, ...(configured ? saved : [])])];
    let cursor = configure ? 1 : 0, all = initial === null, configured = configure && saved.size > 0 && !configError, warning = '', renderedLines = 0;
    const render = () => {
      if (renderedLines) output.write(`\x1b[${renderedLines}A`);
      const count = Math.min(total, Math.max(1, (output.rows || 24) - 6));
      const start = Math.min(Math.max(0, cursor - count + 1), total - count);
      const lines = [`${effective().length}/${max} ${message('selected', '선택')} ${warning}`];
      for (let index = start; index < start + count; index++) {
        if (configure && index === 1) {
          lines.push(`${index === cursor ? '>' : ' '} [${configured ? 'x' : ' '}] ${message('Config Apps (nexia dev config)', 'Config 설정 (nexia dev config)')}${!saved.size || configError ? message(' — setup required', ' — 설정 필요') : ''}`);
          continue;
        }
        const choice = choices[index - 1 - Number(configure && index > 1)];
        const member = index > 0 && saved.has(choice.value);
        const item = index === 0 ? message('All Apps', '전체 앱') : `${choice.label}${member ? ' (Config)' : ''}`;
        const checked = index === 0 ? all : !all && (selected.has(choice.value) || configured && member);
        const limit = index === 0 && choices.length > max ? message(' (over limit)', ' (최대 개수 초과)') : '';
        lines.push(`${index === cursor ? '>' : ' '} [${checked ? 'x' : ' '}] ${item}${limit}`);
      }
      while (lines.length < renderedLines) lines.push('');
      for (const line of lines) {
        const visible = fit(line, output.columns || 100);
        let style = 'muted';
        if (line.startsWith('>')) style = 'accent';
        else if (line.includes('[x]')) style = 'success';
        else if (line.includes('setup required')) style = 'warning';
        output.write(`\r\x1b[2K${paint(visible, style, output)}\n`);
      }
      renderedLines = lines.length;
    };
    output.write(`${paint(label, 'title', output)}\n${saving ? message('↑/↓ move · Space select · Enter save · Ctrl+C cancel', '↑/↓ 이동 · 스페이스 선택 · Enter 저장 · Ctrl+C 취소') : message('↑/↓ move · Space select · Enter start · Ctrl+C cancel', '↑/↓ 이동 · 스페이스 선택 · Enter 실행 · Ctrl+C 취소')}\n`);
    const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
    emitKeypressEvents(input);
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        input.removeListener('keypress', onKey);
        input.removeListener('end', onEnd);
        input.removeListener('error', onError);
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
        output.write('\n');
        if (error) reject(error); else resolve(value);
      };
      const onEnd = () => finish(new Cancelled());
      const onError = error => finish(error);
      const onKey = (text, key = {}) => {
        warning = '';
        if (key.ctrl && ['c', 'd'].includes(key.name) || key.name === 'escape') return onEnd();
        if (configure && cursor === 1 && (key.name === 'space' || text === ' ')) {
          if (configError || !saved.size) warning = configError || message('Run nexia dev config first', '먼저 nexia dev config를 실행하세요');
          else if (!configured && new Set([...selected, ...saved]).size > max) warning = message('Limit reached', '최대 개수 도달');
          else {
            configured = !configured; all = false;
            for (const value of saved) selected.delete(value);
          }
          render();
          return;
        }
        if (key.name === 'up') cursor = (cursor + total - 1) % total;
        else if (key.name === 'down') cursor = (cursor + 1) % total;
        else if (key.name === 'space' || text === ' ') {
          if (cursor === 0) {
            if (choices.length > max) warning = message('Select individual Apps', '개별 앱을 선택하세요');
            else {
              all = !all;
              selected.clear();
              configured = false;
            }
          } else {
            const value = choices[cursor - 1 - Number(configure)].value;
            if (configured && saved.has(value)) warning = message('Included in Config; deselect Config to edit individually', 'Config 포함 앱입니다. 개별 변경은 Config를 해제하세요');
            else if (selected.has(value)) { selected.delete(value); all = false; }
            else if (all || effective().length < max) {
              if (all) selected.clear();
              selected.add(value); all = false;
            }
            else warning = message('Limit reached', '최대 개수 도달');
          }
        } else if (key.name === 'return') {
          if (effective().length) return finish(null, all || configured && configAll ? null : effective());
          warning = message('Select at least one App', '앱을 하나 이상 선택하세요');
        }
        render();
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.once('error', onError);
      input.setRawMode(true);
      input.resume();
      render();
    });
  }
  async function boolean(key, label, defaultValue) {
    if (Object.hasOwn(options, key)) return options[key];
    return (await choice(key, label, [{ value: 'yes', label: message('Yes', '예') }, { value: 'no', label: message('No', '아니요') }], defaultValue ? 'yes' : 'no')) === 'yes';
  }
  async function confirm(summary) {
    output.write(`${summary}\n`);
    if (options['dry-run'] || options.yes) return;
    if (!interactive) throw new InputError(message('Review the plan and add --yes to execute without prompts.', '변경 내용을 확인한 뒤 --yes로 실행하세요.'));
    if (!await boolean('confirm', message('Continue?', '진행할까요?'), false)) throw new Cancelled();
  }
  return { interactive, text, choice, multiChoice, boolean, confirm, setOptions: value => { options = value; }, close: () => reader?.close() };
}
