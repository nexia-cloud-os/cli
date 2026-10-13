// OSC 8 keeps the destination intact even when the terminal wraps the visible text.
export function terminalLink(url, label, stream = process.stdout, env = process.env) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const target = clean(url);
  let parsed;
  try { parsed = new URL(target); } catch { return target; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return target;
  if (!stream.isTTY || env.TERM === 'dumb' || env.CI || env.TERM_PROGRAM === 'Apple_Terminal') return target;
  const known = /^(iTerm.app|WezTerm|vscode|ghostty)$/.test(env.TERM_PROGRAM || '') || env.WT_SESSION || env.KITTY_WINDOW_ID;
  return `\x1b]8;;${target}\x1b\\${known ? clean(label) : target}\x1b]8;;\x1b\\`;
}
