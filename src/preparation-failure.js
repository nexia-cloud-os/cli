import { cleanupStatus } from './cleanup-status.js';
/** Only known diagnostics are rendered. */
export function preparationFailureDetails(failure, check) {
  const cleanup = cleanupStatus([{ operation: null, observations: check?.cleanup }]);
  return failureDetails(failure, check) + cleanup;
}

function failureDetails(failure, check) {
  const stages = { source: 'source validation', database_probe: 'database access check', dependencies: 'PHP dependencies',
    catalog: 'App catalog', migration_preflight: 'applied migration source check', migrate: 'database migrations', initialize: 'App initialization', seed: 'App fixture seeding', serve: 'backend startup',
    references: 'resource references', ingress: 'workspace routing', operator: 'platform preparation' };
  if (!failure || !Object.hasOwn(stages, failure.stage)) return '';
  const diagnostic = failure.diagnostic;
  const kinds = { undefined_method: 'Undefined method', class_not_found: 'Class not found', syntax_error: 'PHP syntax error', type_error: 'PHP type error', runtime_error: 'PHP execution error' };
  const location = diagnostic && Object.hasOwn(kinds, diagnostic.kind)
    && /^(?:runtime\/)?(?:src|database|routes|config|vendor|bootstrap)\/[A-Za-z0-9_./-]+\.php$/.test(diagnostic.file || '')
    && !diagnostic.file.split('/').some(part => !part || part === '.' || part === '..')
    && Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 && diagnostic.line <= 9999999
    ? `\n${kinds[diagnostic.kind]}: ${diagnostic.file}:${diagnostic.line}${typeof diagnostic.symbol === 'string' && /^[A-Za-z_][A-Za-z0-9_\\:]{0,239}$/.test(diagnostic.symbol) ? ` (${diagnostic.symbol})` : ''}` : '';
  const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');
  const message = location && typeof diagnostic.message === 'string' && diagnostic.message.length <= 16384 ? `\n${clean(diagnostic.message)}` : '';
  const trace = location && typeof diagnostic.trace === 'string' && diagnostic.trace.length <= 16384 ? `\n${clean(diagnostic.trace)}` : '';
  const truncated = location && diagnostic.truncated === true ? '\nException details were truncated by the size/frame limit.' : '';
  const stage = `Failed step: ${stages[failure.stage]}.${location}${message}${trace}${truncated}`;
  if (failure.code === 'CATALOG_VALIDATION_FAILED' && failure.stage === 'catalog') {
    const issues = Array.isArray(failure.issues) ? failure.issues.slice(0, 1000) : [];
    const details = issues.filter(issue => issue && typeof issue.field === 'string'
      && /^[a-zA-Z0-9_.:-]{1,240}$/.test(issue.field) && ['invalid', 'too_long', 'query_invalid', 'query_requires_resolve', 'query_requires_paged', 'query_duplicate', 'query_field_undeclared'].includes(issue.rule)).map(issue => {
      const translation = /^catalog\.translations\.([a-zA-Z0-9_-]{1,20})\.(.+)$/.exec(issue.field);
      const guidance = {
        query_field_undeclared: 'This reference query key is absent from ResourceDescriptor::fieldSchema. Declare it only if it is safe to expose publicly, or remove it from querySchema(). Model resourceListFields() is a separate contract.',
        query_duplicate: 'Remove the repeated key from querySchema().',
        query_requires_paged: 'Query conditions require a paged reference provider; implement ResourceReferencePagedSearchContribution or remove these conditions.',
        query_requires_resolve: 'A paged reference provider must also resolve records.',
        query_invalid: 'Declare boolean resolve/paged capabilities and lists of unique field names (up to 1,000 keys, 80 characters each).',
      };
      const length = issue.rule === 'too_long' && Number.isInteger(issue.limit) && issue.limit >= 1 && issue.limit <= 1048576
        && Number.isInteger(issue.actual) && issue.actual >= 0 && issue.actual <= 1048576
        ? `maximum ${issue.limit} characters; actual ${issue.actual}` : guidance[issue.rule] || 'invalid declaration';
      return translation
        ? `  [${issue.rule}] resources/lang/${translation[1]}.json · ${translation[2]}: ${length}`
        : `  [${issue.rule}] ${issue.field}: ${length}`;
    });
    const omitted = Number.isSafeInteger(failure.issues_omitted) && failure.issues_omitted > 0 && failure.issues_omitted <= 1048576
      ? `  ${failure.issues_omitted} additional issue(s) omitted by the 1,000-issue limit.\n` : '';
    return `[CATALOG_VALIDATION_FAILED] ${stage}\nOwner: App catalog.\n${issues.length ? `Catalog issues: ${issues.length + (Number.isSafeInteger(failure.issues_omitted) ? failure.issues_omitted : 0)} total; ${issues.length} shown.\n` : ''}${details.length ? details.join('\n') + '\n' : ''}${omitted}Fix the reported catalog declarations. nexia check checks source only; dynamic reference catalogs are checked by nexia dev. Keep nexia dev running while correcting the declarations.\n`;
  }
  if (failure.code === 'SDK_VERSION_MISMATCH' && failure.stage === 'dependencies'
      && typeof failure.required_sdk === 'string' && /^[0-9vVxX*^~<>=| .+\-]{1,160}$/.test(failure.required_sdk)
      && typeof failure.installed_sdk === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(failure.installed_sdk)
      && failure.installed_sdk.length <= 80) {
    return `[SDK_VERSION_MISMATCH] ${stage}\nOwner: platform/App SDK compatibility.\nApp requires PHP SDK: ${failure.required_sdk}\nServer PHP SDK: ${failure.installed_sdk}\nThe platform runtime does not satisfy this App's composer.json. Adjust App code and dependencies to APIs supported by the server SDK, then run nexia check. Do not lower the required version range without verifying compatibility. If the App needs newer APIs, the platform runtime must be updated. This is not an administrator approval request. Local composer install or deleting .nexia will not change the server SDK.\n`;
  }
  if (failure.code === 'DEPENDENCY_BUILD_FAILED' && failure.stage === 'dependencies') {
    return `[DEPENDENCY_BUILD_FAILED] ${stage}\nOwner: ${location ? 'App PHP source' : 'undetermined dependency build'}.\nFix the reported PHP source location, or check composer.json against the supported PHP dependencies when no source location is reported. Run nexia check from the App folder and keep nexia dev running while correcting the source.\n`;
  }
  if (failure.stage === 'migration_preflight') {
    const causes = {
      DATABASE_MIGRATION_REQUIRED: 'This App database has not been migrated. Run nexia db migrate from the App directory, or nexia db migrate --app <folder-or-key> from the project. Keep nexia dev running; no administrator review is needed.',
      APPLIED_MIGRATION_SOURCE_MISMATCH: 'The database already contains migrations that are missing or changed in this source. Restore the original applied files or switch to the current source; add a new migration for further changes.',
      MIGRATION_OUTCOME_UNCERTAIN: 'An earlier nontransactional migration has an unconfirmed outcome. Inspect and correct the migration effects before explicitly running the migration again. Development source watching continues.',
      MIGRATION_OWNERSHIP_MISMATCH: 'Migration ownership does not match this App. The platform must restore the database allocation; existing data and development source watching are retained.',
    };
    if (!Object.hasOwn(causes, failure.code)) return '';
    const files = Array.isArray(check?.migrations) ? check.migrations.slice(0, 10)
      .filter(item => /^[a-zA-Z0-9_-]{1,255}$/.test(item?.name ?? '') && ['missing', 'changed'].includes(item.reason))
      .map(item => `  ${item.reason}: ${item.name}.php`).join('\n') : '';
    return `[${failure.code}] ${stage}\nOwner: ${failure.code === 'MIGRATION_OWNERSHIP_MISMATCH' ? 'platform database allocation' : 'App migration state'}.\n${causes[failure.code]}\n${files ? `${files}\n` : ''}No App code ran in this attempt. Do not reset data or delete migration history.\n`;
  }
  if (failure.code === 'PREPARATION_FAILED' && failure.stage === 'seed') {
    return `[PREPARATION_FAILED] ${stage}\nOwner: ${location ? 'App fixture or its prerequisites' : 'undetermined fixture execution'}.\nCheck the fixture and its prerequisites, then explicitly rerun nexia db seed <key> --app <app>. Existing data is retained; do not reset the database. A transport failure can leave the outcome uncertain, so inspect the result before retrying.\n`;
  }
  if (failure.code === 'PREPARATION_FAILED') {
    const action = { source: 'Check the App manifest and uploaded source.', catalog: 'Check App metadata and contribution declarations.',
      migrate: 'Check the App migrations; do not delete migration history or reset data.', initialize: 'Check App initialization code; preserve existing data.' };
    if (failure.stage === 'database_probe') {
      const reasons = {
        connection: 'Database connection failed', database_identity: 'Connected to the wrong database',
        schema_isolation: 'Schema access or isolation check failed', schema_create: 'Schema CREATE permission is incorrect',
        cross_database_access: 'Access to the platform database was unexpectedly allowed',
        cross_database_policy: 'Cross-database access policy check failed', probe_exception: 'Database probe could not complete',
      };
      const issues = Array.isArray(failure.probe_issues) ? failure.probe_issues.filter(issue =>
        typeof issue === 'string' && /^(?:migrator|runtime):[a-z_]+$/.test(issue)
        && Object.hasOwn(reasons, issue.split(':')[1])).slice(0, 14) : [];
      return `[PREPARATION_FAILED] ${stage}\nOwner: platform database configuration (Core/Manager); App code did not run.\n${issues.map(issue => {
        const [role, reason] = issue.split(':');
        return `  [${issue}] ${reasons[reason]}`;
      }).join('\n')}${issues.length ? '\n' : 'This runtime did not record a more specific probe reason.\n'}Check the platform database allocation and access policy; keep App data intact.\n`;
    }
    if (!location && ['ingress', 'operator'].includes(failure.stage)) {
      return `[PREPARATION_FAILED] ${stage}\nOwner: platform (Core/Manager). Inspect the operation diagnostics and restore platform service; keep App data intact.\n`;
    }
    if (!location) return `[PREPARATION_FAILED] ${stage}\nOwner: undetermined. Inspect the operation diagnostics before changing App code or platform settings; do not delete migration history or reset data.\n`;
    return `[PREPARATION_FAILED] ${stage}\nOwner: App code. ${Object.hasOwn(action, failure.stage) ? `${action[failure.stage]} ` : ''}Correct the reported App error; development source watching continues.\n`;
  }
  return '';
}

/** Only same-platform, scoped operation links and bounded identifiers reach the terminal. */
export function preparationLocation(operation, endpoint) {
  const uuid = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}';
  if (!new RegExp(`^${uuid}$`).test(operation?.id ?? '')) return '';
  const path = operation.diagnostic_path;
  if (typeof path !== 'string' || !new RegExp(`^/projects/${uuid}/development\\?operation=${operation.id}#operation-${operation.id}$`).test(path)) return '';
  const revision = new RegExp(`^${uuid}$`).test(operation.source_revision_id ?? '')
    ? `Source revision: ${operation.source_revision_id}\n` : '';
  return `${revision}Details: ${new URL(path, endpoint).href}\n`;
}

/** A failed execution is a diagnostic, never a development approval request. */
export function preparationNextAction(operation) {
  if (operation?.database_command) return 'Correct the reported database issue, then run the database command explicitly. Source watching continues; existing data and execution history are retained.';
  if (operation?.failure?.code === 'PREPARATION_FAILED'
      && ['database_probe', 'ingress', 'operator'].includes(operation.failure.stage)) {
    return 'Platform recovery is required. Keep nexia dev running; no App data reset or App source change is indicated by this failure.';
  }
  return 'Correct the reported issue and keep nexia dev running. Changed source is checked automatically; no administrator approval is required.';
}
