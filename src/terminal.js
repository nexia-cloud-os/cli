import { stripVTControlCharacters } from 'node:util';

export const plain = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function paint(value, style, stream = process.stdout, env = process.env) {
  const text = plain(value);
  if (!stream.isTTY || env.TERM === 'dumb' || Object.hasOwn(env, 'NO_COLOR')) return text;
  const brand = /^(truecolor|24bit)$/i.test(env.COLORTERM || '') ? '38;2;0;104;255' : '94';
  return `\x1b[${{ title: '1', accent: '36', muted: '2', warning: '33', success: '32', error: '31', white: '97', brand }[style]}m${text}\x1b[0m`;
}
const characterWidth = character => {
  const codePoint = character.codePointAt(0);
  if (/\p{Mark}/u.test(character) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (/\p{Extended_Pictographic}/u.test(character)) return 2;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
};
export const displayWidth = value => [...plain(value)].reduce((width, character) => width + characterWidth(character), 0);
export function fit(value, columns) {
  let result = '', width = 0;
  for (const character of plain(value)) {
    width += characterWidth(character);
    if (width >= columns) break;
    result += character;
  }
  return result;
}
