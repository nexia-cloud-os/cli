import { terminalLink } from './terminal-link.js';
import { paint, plain } from './terminal.js';

const states = {
  pending: { icon: '○', label: 'WAITING', style: 'muted' },
  running: { icon: '◆', label: 'RUNNING', style: 'accent' },
  success: { icon: '✓', label: 'DONE', style: 'success' },
  warning: { icon: '!', label: 'ACTION', style: 'warning' },
  error: { icon: '✕', label: 'FAILED', style: 'error' },
  stopped: { icon: '■', label: 'STOPPED', style: 'muted' },
};

const safeLines = value => String(value).split(/\r?\n/).map(line => plain(line)).filter(Boolean);
const shorten = (value, limit) => value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 14))}… [truncated]`;
const styleForLevel = level => {
  if (['error', 'fatal', 'critical', 'alert', 'emergency'].includes(level)) return 'error';
  if (['warning', 'warn'].includes(level)) return 'warning';
  return 'muted';
};

function visibleLines(value, { verbose = false, maxLines = 7 } = {}) {
  const lines = safeLines(value);
  const lineLimit = verbose ? 40 : maxLines;
  const widthLimit = verbose ? 1200 : 240;
  const visible = lines.slice(0, lineLimit).map(line => shorten(line, widthLimit));
  if (lines.length > visible.length) visible.push(`… ${lines.length - visible.length} more line(s) omitted; rerun with --verbose.`);
  return visible;
}

export function devTask(name, state, detail, stream = process.stderr) {
  const item = states[state] || states.pending;
  return `${paint(item.icon, item.style, stream)} ${paint(plain(name), 'title', stream)}  ${paint(item.label, item.style, stream)}  ${plain(detail)}`;
}

function box(title, lines, stream) {
  const width = Math.max(plain(title).length + 1, 1, ...lines.map(line => plain(line).length));
  const top = `┌─ ${paint(title, 'title', stream)} ${'─'.repeat(Math.max(0, width - plain(title).length - 1))}┐`;
  return [top, ...lines.map(line => `│ ${line}${' '.repeat(Math.max(0, width - plain(line).length))} │`), `└${'─'.repeat(width + 2)}┘`].join('\n');
}

export function devPanel(title, rows, stream = process.stderr) {
  const width = Math.max(0, ...rows.map(([label]) => plain(label).length));
  const lines = rows.map(([label, value]) => {
    if (value && typeof value === 'object' && value.formatted) return value.formatted;
    const limit = Number.isInteger(stream.columns) ? Math.max(20, stream.columns - width - 8) : Infinity;
    const rendered = value && typeof value === 'object' && value.link
        ? terminalLink(value.link, shorten(plain(value.label || value.link), limit), stream)
        : shorten(plain(value ?? '—'), limit);
    return `${paint(plain(label).padEnd(width), 'muted', stream)}  ${rendered}`;
  });
  return box(title, lines, stream);
}

export function devFailure(error, { verbose = false, maxLines = 7 } = {}) {
  return visibleLines(error?.message || error || 'Unknown failure.', { verbose, maxLines }).join('\n');
}

export function createDevReporter(log = console.error, {
  stream = process.stderr, now = Date.now, heartbeatMs = 15_000, timers = globalThis,
} = {}) {
  const tasks = new Map(), live = Boolean(stream.isTTY && typeof stream.write === 'function');
  let summaryRows = [], renderedLines = 0, paused = false;
  const clear = () => {
    if (!renderedLines) return;
    stream.write(`\x1b[${renderedLines}A\r\x1b[J`);
    renderedLines = 0;
  };
  const dashboard = () => {
    const current = now();
    const rows = summaryRows.map(([label, value]) => [label, value]);
    if (tasks.size) {
      if (rows.length) rows.push(['', '']);
      rows.push(['Progress', '']);
      for (const [name, task] of tasks) {
        const elapsed = task.state === 'running' && current - task.startedAt >= heartbeatMs
          ? ` · ${Math.max(1, Math.floor((current - task.startedAt) / 1000))}s elapsed` : '';
        const detail = shorten(`${task.detail}${elapsed}`, Math.max(20, (stream.columns || 160) - plain(name).length - 20));
        rows.push(['', { formatted: devTask(name, task.state, detail, stream) }]);
      }
    }
    return devPanel('Nexia development', rows, stream);
  };
  const render = () => {
    if (!live || paused || (!summaryRows.length && !tasks.size)) return;
    clear();
    const value = dashboard();
    stream.write(`${value}\n`);
    renderedLines = value.split('\n').length;
  };
  const writeLog = value => {
    if (live) clear();
    log(value);
    if (live) render();
  };
  const timer = stream.isTTY && heartbeatMs > 0 ? timers.setInterval(() => {
    const current = now();
    let changed = false;
    for (const task of tasks.values()) {
      if (task.state !== 'running' || current - task.reportedAt < heartbeatMs) continue;
      task.reportedAt = current;
      changed = true;
    }
    if (changed) render();
  }, Math.min(heartbeatMs, 1000)) : null;
  timer?.unref?.();

  const task = (name, state, detail) => {
    const previous = tasks.get(name);
    if (previous?.state === state && previous.detail === detail) return;
    const timestamp = now();
    tasks.set(name, { state, detail, startedAt: timestamp, reportedAt: timestamp });
    if (live) render(); else log(devTask(name, state, detail, stream));
  };

  return {
    task,
    summary(rows) {
      const merged = new Map(summaryRows.map(row => [row[0], row[1]]));
      for (const [label, value] of rows) merged.set(label, value);
      summaryRows = [...merged];
      if (live) render(); else log(devPanel('Nexia development', rows, stream));
    },
    pause({ retain = false } = {}) { paused = true; if (live && !retain) clear(); },
    resume() { paused = false; render(); },
    panel(title, rows) { writeLog(devPanel(title, rows, stream)); },
    message(name, value, { verbose = false } = {}) {
      const visible = visibleLines(value, { verbose });
      const lines = visible.map((line, index) => {
        const level = line.match(/^\[[^\]]+\s+(error|fatal|critical|alert|emergency|warning|warn)\]/)?.[1];
        const style = styleForLevel(level);
        return `${paint(index ? '│' : '└', style, stream)} ${paint(name, 'muted', stream)}  ${paint(line, style, stream)}`;
      });
      if (lines.length) writeLog(lines.join('\n'));
    },
    failure(name, error, { verbose = false, next } = {}) {
      const lines = safeLines(devFailure(error, { verbose }));
      const headline = lines.shift() || 'Unknown failure.';
      task(name, 'error', headline);
      const details = lines.map(line => `${paint('│', 'error', stream)} ${paint(name, 'muted', stream)}  ${line}`);
      if (live && paused) details.unshift(devTask(name, 'error', headline, stream));
      if (next) details.push(`${paint('└', 'warning', stream)} ${paint(name, 'muted', stream)}  Next: ${plain(next)}`);
      if (details.length) writeLog(details.join('\n'));
    },
    close() { if (timer) timers.clearInterval(timer); },
  };
}
