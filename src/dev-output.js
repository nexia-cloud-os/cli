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

export function devPanel(title, rows, stream = process.stderr) {
  const width = Math.max(0, ...rows.map(([label]) => plain(label).length));
  const lines = [`┌─ ${paint(title, 'title', stream)}`];
  for (const [label, value] of rows) {
    const rendered = value && typeof value === 'object' && value.link
      ? terminalLink(value.link, value.label || value.link, stream)
      : plain(value ?? '—');
    lines.push(`│ ${paint(plain(label).padEnd(width), 'muted', stream)}  ${rendered}`);
  }
  lines.push('└─');
  return lines.join('\n');
}

export function devFailure(error, { verbose = false, maxLines = 7 } = {}) {
  return visibleLines(error?.message || error || 'Unknown failure.', { verbose, maxLines }).join('\n');
}

export function createDevReporter(log = console.error, {
  stream = process.stderr, now = Date.now, heartbeatMs = 15_000, timers = globalThis,
} = {}) {
  const tasks = new Map();
  const emit = (name, state, detail) => log(devTask(name, state, detail, stream));
  const timer = stream.isTTY && heartbeatMs > 0 ? timers.setInterval(() => {
    const current = now();
    for (const [name, task] of tasks) {
      if (task.state !== 'running' || current - task.reportedAt < heartbeatMs) continue;
      task.reportedAt = current;
      emit(name, 'running', `${task.detail} · ${Math.max(1, Math.floor((current - task.startedAt) / 1000))}s elapsed`);
    }
  }, Math.min(heartbeatMs, 1000)) : null;
  timer?.unref?.();

  const task = (name, state, detail) => {
    const previous = tasks.get(name);
    if (previous?.state === state && previous.detail === detail) return;
    const timestamp = now();
    tasks.set(name, { state, detail, startedAt: timestamp, reportedAt: timestamp });
    emit(name, state, detail);
  };

  return {
    task,
    panel(title, rows) { log(devPanel(title, rows, stream)); },
    message(name, value, { verbose = false } = {}) {
      const visible = visibleLines(value, { verbose });
      for (const [index, line] of visible.entries()) {
        const level = line.match(/^\[[^\]]+\s+(error|fatal|critical|alert|emergency|warning|warn)\]/)?.[1];
        const style = styleForLevel(level);
        log(`${paint(index ? '│' : '└', style, stream)} ${paint(name, 'muted', stream)}  ${paint(line, style, stream)}`);
      }
    },
    failure(name, error, { verbose = false, next } = {}) {
      const lines = safeLines(devFailure(error, { verbose }));
      task(name, 'error', lines.shift() || 'Unknown failure.');
      for (const line of lines) log(`${paint('│', 'error', stream)} ${paint(name, 'muted', stream)}  ${line}`);
      if (next) log(`${paint('└', 'warning', stream)} ${paint(name, 'muted', stream)}  Next: ${plain(next)}`);
    },
    close() { if (timer) timers.clearInterval(timer); },
  };
}
