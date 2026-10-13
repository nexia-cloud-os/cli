import { InputError } from './commands.js';
import { request, validateEndpoint } from './connection.js';

export async function readDocs(name, argument, locale) {
  if (!['en', 'ko'].includes(locale)) throw new InputError('Use --locale en or --locale ko.');
  const search = name === 'docs search';
  const value = name === 'docs' ? 'getting-started-agent-assisted-development' : argument?.trim();
  if (search ? !value || value.length > 200 : !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '')) {
    throw new InputError(search ? 'Use nexia docs search "query" (1–200 characters).' : 'Use nexia docs read <document-id> from a search result.');
  }
  // Public documentation must not read or forward project credentials.
  const endpoint = validateEndpoint(process.env.NEXIA_ENDPOINT || 'https://developers.nexia.to');
  const query = new URLSearchParams({ locale, ...(search ? { q: value } : {}) });
  const data = await request({ endpoint }, `docs${search ? '' : `/${value}`}?${query}`, { authenticated: false });
  const summary = document => document && typeof document.id === 'string' && typeof document.title === 'string'
    && typeof document.description === 'string' && typeof document.url === 'string' && typeof document.source_locale === 'string';
  if (search ? !Array.isArray(data?.documents) || !data.documents.every(summary) || !Number.isInteger(data.total)
    : !summary(data) || typeof data.content !== 'string') {
    throw new Error('Invalid documentation response. Check that the selected Developers site supports nexia docs.');
  }
  return data;
}

export function formatDocs(data) {
  if (Array.isArray(data.documents)) {
    return data.documents.length ? [
      ...data.documents.map(document => `${document.id} — ${document.title}\n${document.description}\n${document.url} (source: ${document.source_locale})`),
      `${data.documents.length}/${data.total} results. Read: nexia docs read <document-id>.${data.total > data.documents.length ? ' Narrow your query for other results.' : ''}`,
    ].join('\n\n') : 'No matching documents. Try another term or --locale en.';
  }
  return `${data.title}\nSource: ${data.url}\nLanguage: ${data.source_locale}${data.locale_status === 'fallback' ? ` (fallback for ${data.locale})` : ''}\n\n${data.content}`;
}
