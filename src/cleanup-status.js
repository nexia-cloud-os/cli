/** Render bounded operator observations; never echo arbitrary diagnostic content. */
export function cleanupStatus(rows) {
  if (!Array.isArray(rows)) return '';
  const labels = { containers: 'Execution resources', files: 'Temporary files', networks: 'Private networks' };
  const lines = [];
  for (const row of rows.slice(0, 10)) {
    if (row?.operation !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row?.operation ?? '')) continue;
    for (const [kind, label] of Object.entries(labels)) {
      const state = row.observations?.[kind];
      if (!['removed', 'pending', 'protected', 'blocked'].includes(state?.status)) continue;
      const reason = ['app_container_attached', 'configured_allocation', 'container_not_disposable'].includes(state.reason)
        ? 'resources in use or retained by policy'
        : ['stop_unconfirmed_or_retention', 'stop_receipt_restored', 'credentials_not_revoked'].includes(state.reason)
          ? 'waiting for stop and credential revocation' : 'permission or removal not yet confirmed';
      lines.push(`  ${label}: ${state.status === 'removed' ? 'removal confirmed' : `pending; ${reason}; checked again automatically`}${row.operation ? ` (${row.operation})` : ''}`);
    }
  }
  return lines.length ? '\n'+lines.join('\n') : '';
}
