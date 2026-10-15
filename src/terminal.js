import { stripVTControlCharacters } from 'node:util';

export const plain = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function paint(value, style, stream = process.stdout, env = process.env) {
  const text = plain(value);
  if (!stream.isTTY || env.TERM === 'dumb' || Object.hasOwn(env, 'NO_COLOR')) return text;
  const brand = /^(truecolor|24bit)$/i.test(env.COLORTERM || '') ? '38;2;0;104;255' : '94';
  return `\x1b[${{ title: '1', accent: '36', muted: '2', warning: '33', success: '32', error: '31', white: '97', brand }[style]}m${text}\x1b[0m`;
}
export function fit(value, columns) {
  let result = '', width = 0;
  for (const character of plain(value)) {
    width += character.codePointAt(0) < 128 ? 1 : 2;
    if (width >= columns) break;
    result += character;
  }
  return result;
}
