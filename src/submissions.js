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

export function formatSubmission(result) {
  const { submission, review, build } = result;
  const lines = [];
  if (result.submission_reused === true) lines.push('Already submitted. Showing the existing submission; no new submission was created.');
  else if (result.submission_reused === false) lines.push('Submission received for review.');
  lines.push(`${submission.tag}: ${submission.status}`, `Submission: ${submission.id}`);
  if (submission.commit_sha) lines.push(`Commit: ${submission.commit_sha}`);
  if (submission.failure) lines.push(`Failure: ${submission.failure}`);
  if (submission.failure === 'test_recipe_mismatch') lines.push('App checks stopped before execution because the platform test environment versions did not match. No App code change or new tag is needed.');
  if (build?.review_note) lines.push(`Review note: ${build.review_note}`);
  if (review) {
    lines.push(`Review: ${review.status}`);
    for (const check of review.checks ?? []) lines.push(`  ${check.title || check.key}: ${check.status}`);
    if (review.analysis_progress) lines.push(`Analysis: ${review.analysis_progress.completed}/${review.analysis_progress.total}`);
  }
  let next;
  switch (submission.status) {
    case 'waiting':
      next = 'Source collection or an earlier submission is pending. Check status later; do not submit again.';
      break;
    case 'queued':
    case 'building':
    case 'running':
      next = 'Build is pending or running. Check status later; do not submit again.';
      break;
    case 'built':
      next = review?.ready_for_human_review
        ? 'Checks passed. Await administrator review; approval and publication are separate.'
        : 'Checks are incomplete. Inspect the checks and feedback in Developers before retrying or changing code.';
      break;
    case 'approved':
      next = 'Approved. Await administrator publication; this does not confirm deployment.';
      break;
    case 'published':
      next = 'Published. Check nexia status or contact the operator for deployment availability; publication does not confirm deployment or installation.';
      break;
    case 'failed':
      if (submission.retryable && submission.retry_ready === false) {
        next = submission.retry_blocked_reason === 'artifact_toolchain_not_ready'
          ? 'The platform test environment correction is pending. Check this submission again after it is applied; do not submit again.'
          : 'Retry is not ready. Check the submission in Developers before taking further action.';
      } else {
        next = submission.retryable
          ? `Retry the existing submission: nexia submit retry ${submission.id}${submission.failure === 'test_recipe_mismatch' ? ' (no administrator approval required)' : ''}`
          : 'Inspect the failure in Developers. Code changes need a new version tag; contact support for uncertain build outcomes.';
      }
      break;
    case 'needs_review':
      next = 'Contact developer support to reconcile the build outcome. Do not reset data or submit duplicate work.';
      break;
    case 'rejected':
      next = 'Read the review feedback in Developers, address it, and submit a new version tag. Do not move the old tag.';
      break;
    case 'cancelled':
      next = 'This submission is cancelled. Submit a new version tag to request another review.';
      break;
    default:
      next = 'Inspect the current submission in Developers before taking further action.';
  }
  lines.push(`Next: ${next}`, `Check: nexia submit status ${submission.id}`);
  return lines.map(plain).join('\n');
}
