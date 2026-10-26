import { terminalLink } from './terminal-link.js';
import { displayWidth, fit, paint, plain } from './terminal.js';

const states = {
  pending: { icon: '○', label: 'WAITING', style: 'muted' },
  running: { icon: '◆', label: 'PROCESSING', style: 'accent' },
  success: { icon: '✓', label: 'DONE', style: 'success' },
  warning: { icon: '!', label: 'ACTION', style: 'warning' },
  error: { icon: '✕', label: 'FAILED', style: 'error' },
  stopped: { icon: '■', label: 'STOPPED', style: 'muted' },
};

const releaseVersion = value => typeof value === 'string' && value.length <= 80
  && /^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);

export function serverVersionRows(versions) {
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return [];
  const rows = [['Server Core', versions.core], ['Core PHP SDK', versions.php_sdk], ['Core React SDK', versions.react_sdk]];
  return rows.every(([, version]) => releaseVersion(version)) ? rows : [];
}

const safeLines = value => String(value).split(/\r?\n/).map(line => plain(line)).filter(Boolean);
const shorten = (value, limit) => {
  const text = plain(value), marker = '… [truncated]';
  return !Number.isFinite(limit) || displayWidth(text) <= limit ? text
    : `${fit(text, Math.max(2, limit - displayWidth(marker) + 1))}${marker}`;
};
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
  const width = Math.max(displayWidth(title) + 1, 1, ...lines.map(displayWidth));
  const top = `┌─ ${paint(title, 'title', stream)} ${'─'.repeat(Math.max(0, width - displayWidth(title) - 1))}┐`;
  return [top, ...lines.map(line => `│ ${line}${' '.repeat(Math.max(0, width - displayWidth(line)))} │`), `└${'─'.repeat(width + 2)}┘`].join('\n');
}

export function devPanel(title, rows, stream = process.stderr) {
  const width = Math.max(0, ...rows.map(([label]) => displayWidth(label)));
  const panelWidth = Number.isInteger(stream.columns) ? Math.max(24, Math.min(120, stream.columns - 2)) : Infinity;
  const lines = rows.flatMap(([label, value]) => {
    if (value && typeof value === 'object' && value.formatted) return value.formatted;
    const limit = Math.max(12, panelWidth - width - 6);
    const rendered = value && typeof value === 'object' && value.link
        ? terminalLink(value.link, shorten(plain(value.label || value.link), limit), stream)
        : shorten(plain(value ?? '—'), limit);
    const labelText = plain(label);
    // Plain-URL terminals ignore link labels; wrap their full destination inside the box.
    if (displayWidth(rendered) > limit) {
      const wrapped = [];
      let remaining = plain(rendered);
      while (remaining) {
        const chunk = fit(remaining, limit + 1);
        const heading = wrapped.length ? '' : labelText;
        wrapped.push(`${paint(`${heading}${' '.repeat(width - displayWidth(heading))}`, 'muted', stream)}  ${chunk}`);
        remaining = remaining.slice(chunk.length);
      }
      return wrapped;
    }
    return `${paint(`${labelText}${' '.repeat(width - displayWidth(labelText))}`, 'muted', stream)}  ${rendered}`;
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
  let summaryRows = [], detailLines = [], omittedDetails = 0, renderedLines = 0, paused = false, closed = false;
  const activeFailures = new Set(), omittedFailures = new Map();
  const outputWidth = () => Math.max(24, Math.min(120, (stream.columns || 122) - 2));
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
        const elapsed = ['pending', 'running'].includes(task.state) && current - task.startedAt >= heartbeatMs
          ? ` · ${Math.max(1, Math.floor((current - task.startedAt) / 1000))}s elapsed` : '';
        const prefix = devTask(name, task.state, '', stream);
        const detail = shorten(`${task.detail}${elapsed}`, Math.max(20, outputWidth() - displayWidth(prefix) - 4));
        rows.push(['', { formatted: devTask(name, task.state, detail, stream) }]);
      }
    }
    return devPanel('Nexia development', rows, stream);
  };
  const render = (final = false) => {
    if (!live || paused || closed || (!summaryRows.length && !tasks.size)) return;
    clear();
    const maxLines = final ? Infinity : Math.max(1, (stream.rows || 40) - 1);
    const panelLines = dashboard().split('\n');
    if (panelLines.length > maxLines) {
      panelLines.splice(Math.min(1, maxLines - 1), panelLines.length - maxLines + 1, paint(shorten('… summary rows omitted; enlarge the terminal.', outputWidth()), 'muted', stream));
    }
    const panel = panelLines.join('\n');
    const room = Math.max(0, maxLines - panelLines.length - 2);
    const hidden = omittedDetails + Math.max(0, detailLines.length - room);
    const visibleCount = Math.max(0, room - Number(hidden > 0));
    const visible = visibleCount ? detailLines.slice(-visibleCount).map(line => line.value) : [];
    if (hidden && room) visible.unshift(paint(`… ${hidden} earlier detail line(s) omitted.`, 'muted', stream));
    const failed = [...tasks.values()].some(task => task.state === 'error');
    const detailTitle = failed
      ? `${paint('Details', 'title', stream)} · resolve ${paint('FAILED', 'error', stream)} items first`
      : paint('Details', 'title', stream);
    const value = visible.length ? `${panel}\n\n${detailTitle}\n${visible.join('\n')}` : panel;
    stream.write(`${value}\n`);
    renderedLines = value.split('\n').length;
  };
  const writeLog = (value, { owner, failure = false } = {}) => {
    if (failure && owner) activeFailures.add(owner);
    if (!live) { log(value); return; }
    detailLines.push(...String(value).split(/\r?\n/).filter(Boolean).map(line => ({ value: line, owner, failure })));
    if (detailLines.length > 200) {
      const omitted = detailLines.splice(0, detailLines.length - 200);
      omittedDetails += omitted.length;
      for (const line of omitted) {
        if (line.failure && line.owner) omittedFailures.set(line.owner, (omittedFailures.get(line.owner) || 0) + 1);
      }
    }
    render();
  };
  const formatDetail = (marker, name, value, style, wrap = false) => {
    const prefix = `${marker} ${plain(name)}  `;
    const width = Math.max(20, outputWidth() - displayWidth(prefix));
    const details = [];
    let remaining = plain(value);
    do {
      const detail = wrap ? fit(remaining, width + 1) : shorten(remaining, width);
      details.push(`${paint(marker, style, stream)} ${paint(name, 'title', stream)}  ${paint(detail, style, stream)}`);
      remaining = wrap ? remaining.slice(detail.length) : '';
    } while (remaining);
    return details.join('\n');
  };
  const timer = stream.isTTY && heartbeatMs > 0 ? timers.setInterval(() => {
    const current = now();
    let changed = false;
    for (const task of tasks.values()) {
      if (!['pending', 'running'].includes(task.state) || current - task.reportedAt < heartbeatMs) continue;
      task.reportedAt = current;
      changed = true;
    }
    if (changed) render();
  }, Math.min(heartbeatMs, 1000)) : null;
  timer?.unref?.();

  const task = (name, state, detail) => {
    const previous = tasks.get(name);
    if (previous?.state === state && previous.detail === detail) return;
    if (state === 'error') activeFailures.add(name);
    const timestamp = now();
    tasks.set(name, { state, detail, startedAt: timestamp, reportedAt: timestamp });
    if (live) render(); else log(devTask(name, state, detail, stream));
  };

  return {
    task,
    summary(rows, { after } = {}) {
      if (!rows.length) return;
      if (after !== undefined) {
        const labels = new Set(rows.map(([label]) => label));
        const retained = summaryRows.filter(([label]) => !labels.has(label));
        const index = retained.findIndex(([label]) => label === after);
        retained.splice(index < 0 ? retained.length : index + 1, 0, ...rows);
        summaryRows = retained;
        if (live) render(); else log(devPanel('Nexia development', rows, stream));
        return;
      }
      const merged = new Map(summaryRows.map(row => [row[0], row[1]]));
      for (const [label, value] of rows) merged.set(label, value);
      summaryRows = [...merged];
      if (live) render(); else log(devPanel('Nexia development', rows, stream));
    },
    pause({ retain = false } = {}) { paused = true; if (live && !retain) clear(); },
    resume() { paused = false; render(); },
    resolve(name) {
      const resolved = activeFailures.delete(name);
      detailLines = detailLines.filter(line => !(line.failure && line.owner === name));
      omittedDetails -= omittedFailures.get(name) || 0;
      omittedFailures.delete(name);
      return resolved;
    },
    panel(title, rows) { writeLog(devPanel(title, rows, stream)); },
    message(name, value, { verbose = false, failure = false } = {}) {
      const diagnostic = /^\[[^\]]+\s+(error|fatal|critical|alert|emergency)\]/.test(plain(value));
      const visible = failure ? safeLines(value) : visibleLines(value, { verbose: verbose || diagnostic });
      const lines = visible.map(line => {
        const level = line.match(/^\[[^\]]+\s+(error|fatal|critical|alert|emergency|warning|warn)\]/)?.[1];
        const style = failure ? 'error' : styleForLevel(level);
        const marker = style === 'error' ? '✕' : style === 'warning' ? '!' : '·';
        return formatDetail(marker, name, line, style, failure || style === 'error');
      });
      if (lines.length) writeLog(lines.join('\n'), { owner: name, failure });
    },
    failure(name, error, { verbose = false, next, summary } = {}) {
      const lines = safeLines(error?.message || error || 'Unknown failure.');
      if (verbose && error?.platformRequest) lines.push(...safeLines(`Request: ${error.platformRequest}`));
      if (verbose && error?.platformStatus) lines.push(...safeLines(`Status: ${error.platformStatus}`));
      const headline = lines.shift() || 'Unknown failure.';
      task(name, 'error', summary || headline);
      const details = lines.map(line => formatDetail('✕', name, line, 'error', true));
      details.unshift(formatDetail('✕', name, headline, 'error', true));
      if (next) details.push(formatDetail('→', name, `Next: ${plain(next)}`, 'warning', true));
      if (details.length) writeLog(details.join('\n'), { owner: name, failure: true });
    },
    close() {
      if (closed) return;
      if (timer) timers.clearInterval(timer);
      render(true);
      closed = true;
    },
  };
}
