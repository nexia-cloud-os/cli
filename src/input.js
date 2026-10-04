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
  return { interactive, text, choice, boolean, confirm, setOptions: value => { options = value; }, close: () => reader?.close() };
}
