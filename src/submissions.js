import { request } from './connection.js';
import { InputError } from './commands.js';
import { message } from './input.js';
import { plain } from './terminal.js';

export async function recentSubmissions(config, { page = 1, appId } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new InputError('--page must be between 1 and 10000.');
  const query = new URLSearchParams({ page: String(page), ...(appId ? { app_id: appId } : {}) });
  const result = await request(config, `v2/submissions?${query}`);
  if (!Array.isArray(result?.submissions) || result.page !== page || typeof result.has_more !== 'boolean'
    || result.project?.id !== config.project.id
    || result.submissions.some(row => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id || '')
      || !['tag', 'status', 'created_at'].every(key => typeof row[key] === 'string'))) throw new Error('Invalid submission list response.');
  return result;
}

const label = row => plain(`${row.app?.name || row.app?.key || 'App'} · ${row.tag} · ${row.status} · ${row.created_at}`);
export function formatSubmissions(result) {
  if (!result.submissions.length) return message('No submissions found. Submit an existing tag with nexia submit --tag <tag>.', '제출 내역이 없습니다. nexia submit --tag <tag>로 기존 태그를 제출하세요.');
  return [plain(`${result.project.name} · ${message('Page', '페이지')} ${result.page}`),
    ...result.submissions.map(row => `${label(row)}\n  ${row.id}`),
    ...(result.has_more ? [`nexia submit list --page ${result.page + 1}`] : []),
    'nexia submit status <submission-id>',
  ].join('\n');
}

export async function selectSubmission(config, input, { appId, action = 'status' } = {}) {
  let page = 1;
  while (true) {
    const result = await recentSubmissions(config, { page, appId });
    if (!input.interactive || !result.submissions.length) return { list: result };
    const choices = result.submissions.map(row => ({ value: row.id, label: `${label(row)} · …${row.id.slice(-8)}` }));
    if (result.has_more) choices.push({ value: 'next', label: message('Older submissions →', '이전 제출 더 보기 →') });
    if (page > 1) choices.push({ value: 'previous', label: message('← Newer submissions', '← 최신 제출 보기') });
    const id = await input.choice('submission-id', plain(`${result.project.name} · ${message('Select submission', '제출 선택')} (${action})`), choices);
    if (id === 'next') page++;
    else if (id === 'previous') page--;
    else return { id, label: label(result.submissions.find(row => row.id === id)) };
  }
}
