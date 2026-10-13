import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { InputError } from './commands.js';
export class Cancelled extends Error { constructor() { super('Cancelled / 취소됨'); this.code = 'CANCELLED'; this.exitCode = 130; } }
export const language = /^(ko)(?:[_-]|$)/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'ko' : 'en';
export const message = (en, ko) => language === 'ko' ? ko : en;
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
    const labels = choices.map((item, i) => `  ${i + 1}. ${typeof item === 'string' ? item : item.label}`).join('\n');
    const answer = await text(key, `${label}\n${labels}`, { defaultValue: defaultValue ?? '', required: true, validate: value => values.includes(value) || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= values.length) });
    return values.includes(answer) ? answer : values[Number(answer) - 1];
  }
  async function multiChoice(label, choices, { max }) {
    if (!interactive) throw new InputError('Repeat --app to select Apps.');
    const selected = new Set();
    let cursor = 0, all = false, warning = '', renderedLines = 0;
    const render = () => {
      if (renderedLines) output.write(`\x1b[${renderedLines}A`);
      const count = Math.min(choices.length + 1, Math.max(1, Math.min(8, (output.rows || 24) - 5)));
      const start = Math.min(Math.max(0, cursor - count + 1), choices.length + 1 - count);
      const lines = [`${selected.size}/${max} ${message('selected', '선택')} ${warning}`];
      for (let index = start; index < start + count; index++) {
        const item = index === 0 ? message('All Apps', '전체 앱') : choices[index - 1].label;
        const checked = index === 0 ? all : selected.has(choices[index - 1].value);
        const limit = index === 0 && choices.length > max ? message(' (over limit)', ' (최대 개수 초과)') : '';
        lines.push(`${index === cursor ? '>' : ' '} [${checked ? 'x' : ' '}] ${item}${limit}`);
      }
      while (lines.length < renderedLines) lines.push('');
      for (const line of lines) {
        // Bound wide characters too, so wrapped lines do not corrupt redraws.
        output.write(`\r\x1b[2K${Array.from(line).slice(0, Math.max(1, Math.floor((output.columns || 100) / 2) - 1)).join('')}\n`);
      }
      renderedLines = lines.length;
    };
    output.write(`${label}\n${message('↑/↓ move · Space select · Enter start · Ctrl+C cancel', '↑/↓ 이동 · 스페이스 선택 · Enter 실행 · Ctrl+C 취소')}\n`);
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
        if (key.name === 'up') cursor = (cursor + choices.length) % (choices.length + 1);
        else if (key.name === 'down') cursor = (cursor + 1) % (choices.length + 1);
        else if (key.name === 'space' || text === ' ') {
          if (cursor === 0) {
            if (choices.length > max) warning = message('Select individual Apps', '개별 앱을 선택하세요');
            else {
              all = !all;
              selected.clear();
              if (all) for (const choice of choices) selected.add(choice.value);
            }
          } else {
            const value = choices[cursor - 1].value;
            if (selected.has(value)) { selected.delete(value); all = false; }
            else if (selected.size < max) { selected.add(value); all = false; }
            else warning = message('Limit reached', '최대 개수 도달');
          }
        } else if (key.name === 'return') {
          if (selected.size) return finish(null, all ? null : [...selected]);
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
