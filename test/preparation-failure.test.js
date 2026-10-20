import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationFailureDetails } from '../src/preparation-failure.js';

const mismatch = { code: 'SDK_VERSION_MISMATCH', stage: 'dependencies', required_sdk: '^0.8.6 || ^0.9.0', installed_sdk: 'v0.8.4' };

test('SDK mismatch identifies server versus App versions and the developer recovery path', () => {
  const message = preparationFailureDetails(mismatch);
  assert.match(message, /App requires PHP SDK: \^0\.8\.6 \|\| \^0\.9\.0/);
  assert.match(message, /Server PHP SDK: v0\.8\.4/);
  assert.match(message, /then run nexia check/);
  assert.match(message, /Do not lower the required version range without verifying compatibility/);
  assert.match(message, /the platform runtime must be updated/);
  assert.match(message, /Local composer install or deleting \.nexia will not change/);
  assert.doesNotMatch(message, /restart nexia dev|safe to retry/i);
});

test('old, unknown and terminal-control diagnostics are not rendered', () => {
  for (const failure of [null, {}, { code: 'UNKNOWN', stage: 'dependencies', message: 'secret' },
    { ...mismatch, required_sdk: '^0.8.6\nFAKE SUCCESS' }, { ...mismatch, installed_sdk: '\x1b[2J0.8.4' },
    { ...mismatch, required_sdk: '1'.repeat(161) }, { ...mismatch, stage: '__proto__' },
    { ...mismatch, stage: 'migrate' }]) assert.equal(preparationFailureDetails(failure), '');
  assert.doesNotMatch(preparationFailureDetails({ ...mismatch, stderr: 'password=secret' }), /password|secret/);
});

test('uncertain migration failures retain evidence and identify the failed step', () => {
  const message = preparationFailureDetails({ code: 'PREPARATION_FAILED', stage: 'migrate' });
  assert.match(message, /database migrations/);
  assert.match(message, /do not delete migration history or reset data/);
  assert.doesNotMatch(message, /safe to retry|restart nexia dev/i);
});

test('migration diagnostics show bounded safe file names without granting retry', () => {
  const message = preparationFailureDetails({ code: 'APPLIED_MIGRATION_SOURCE_MISMATCH', stage: 'migration_preflight' }, {
    migrations: [{ name: '2026_10_14_payroll', reason: 'missing' }, { name: '\x1b[2Jprivate', reason: 'missing' }],
  });
  assert.match(message, /missing: 2026_10_14_payroll.php/);
  assert.match(message, /Restore the original applied files/);
  assert.doesNotMatch(message, /private|safe to retry|restart nexia dev/i);
});

test('diagnostic navigation rejects external links and unrelated operation anchors', async () => {
  const { preparationLocation } = await import('../src/preparation-failure.js');
  const id = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222';
  const diagnostic_path = `/projects/${project}/development?operation=${id}#operation-${id}`;
  assert.match(preparationLocation({ id, diagnostic_path }, 'https://developers.example'), /https:\/\/developers.example\/projects\//);
  for (const path of ['https://evil.example', '//evil.example', diagnostic_path + '\nFAKE', diagnostic_path.replace(`#operation-${id}`, `#operation-${project}`)]) {
    assert.equal(preparationLocation({ id, diagnostic_path: path }, 'https://developers.example'), '');
  }
});

test('catalog errors name the file, exact dotted key and lengths without granting retry', () => {
  const message = preparationFailureDetails({ code: 'CATALOG_VALIDATION_FAILED', stage: 'catalog', issues: [
    { field: 'catalog.translations.en.payroll.approval.description', rule: 'too_long', limit: 2000, actual: 2001, value: 'PRIVATE' },
    { field: 'catalog.permissions.0.key', rule: 'invalid', limit: null, actual: null },
    { field: '\x1b[2JPRIVATE', rule: 'invalid' },
  ] });
  assert.match(message, /File: resources\/lang\/en.json\n  Key: payroll.approval.description/);
  assert.match(message, /maximum 2000 characters; actual 2001/);
  assert.match(message, /invalid declaration\ncatalog.permissions.0.key/);
  assert.match(message, /nexia check/);
  assert.doesNotMatch(message, /PRIVATE|safe to retry|No App code ran/);
  assert.match(preparationFailureDetails({ code: 'CATALOG_VALIDATION_FAILED', stage: 'catalog', issues: [] }), /Fix the reported catalog declarations/);
});

test('platform preparation errors do not tell developers to modify App code', () => {
  for (const stage of ['database_probe', 'ingress', 'operator']) {
    const output = preparationFailureDetails({ code: 'PREPARATION_FAILED', stage });
    assert.match(output, /Platform preparation failed/);
    assert.match(output, /retry nexia dev/);
    assert.doesNotMatch(output, /Correct the App code|contact|administrator/);
  }
  const output = preparationFailureDetails({ code: 'PREPARATION_FAILED', stage: 'catalog',
    diagnostic: { kind: 'undefined_method', file: 'src/Manifest.php', line: 12, symbol: 'Trial::missing' } });
  assert.match(output, /Undefined method: src\/Manifest.php:12 \(Trial::missing\)/);
  assert.match(output, /Correct the reported App error/);
});
