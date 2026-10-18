/** Only known diagnostics are rendered. */
export function preparationFailureDetails(failure, check) {
  const stages = { source: 'source validation', database_probe: 'database access check', dependencies: 'PHP dependencies',
    catalog: 'App catalog', migration_preflight: 'applied migration source check', migrate: 'database migrations', initialize: 'App initialization', serve: 'backend startup',
    references: 'resource references', ingress: 'workspace routing', operator: 'platform preparation' };
  if (!failure || !Object.hasOwn(stages, failure.stage)) return '';
  const diagnostic = failure.diagnostic;
  const kinds = { undefined_method: 'Undefined method', class_not_found: 'Class not found', syntax_error: 'PHP syntax error', type_error: 'PHP type error', runtime_error: 'PHP execution error' };
  const location = diagnostic && Object.hasOwn(kinds, diagnostic.kind)
    && /^(?:src|database|routes|config)\/[A-Za-z0-9_./-]+\.php$/.test(diagnostic.file || '')
    && !diagnostic.file.split('/').some(part => !part || part === '.' || part === '..')
    && Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 && diagnostic.line <= 9999999
    ? `\n${kinds[diagnostic.kind]}: ${diagnostic.file}:${diagnostic.line}${typeof diagnostic.symbol === 'string' && /^[A-Za-z_][A-Za-z0-9_\\:]{0,239}$/.test(diagnostic.symbol) ? ` (${diagnostic.symbol})` : ''}` : '';
  const stage = `Failed step: ${stages[failure.stage]}.${location}`;
  if (failure.code === 'CATALOG_VALIDATION_FAILED' && failure.stage === 'catalog') {
    const issues = Array.isArray(failure.issues) ? failure.issues.slice(0, 10) : [];
    const details = issues.filter(issue => issue && typeof issue.field === 'string'
      && /^[a-zA-Z0-9_.:-]{1,240}$/.test(issue.field) && ['invalid', 'too_long'].includes(issue.rule)).map(issue => {
      const translation = /^catalog\.translations\.([a-zA-Z0-9_-]{1,20})\.(.+)$/.exec(issue.field);
      const length = issue.rule === 'too_long' && Number.isInteger(issue.limit) && issue.limit >= 1 && issue.limit <= 1048576
        && Number.isInteger(issue.actual) && issue.actual >= 0 && issue.actual <= 1048576
        ? `maximum ${issue.limit} characters; actual ${issue.actual}` : 'invalid declaration';
      return translation
        ? `  Translation: ${length}\n  File: resources/lang/${translation[1]}.json\n  Key: ${translation[2]}`
        : `  ${length}\n${issue.field}`;
    });
    return `[CATALOG_VALIDATION_FAILED] ${stage}\n${details.length ? details.join('\n') + '\n' : ''}Fix the reported catalog declarations and run nexia check from the App folder. Keep nexia dev running while correcting the declarations.\n`;
  }
  if (failure.code === 'SDK_VERSION_MISMATCH' && failure.stage === 'dependencies'
      && typeof failure.required_sdk === 'string' && /^[0-9vVxX*^~<>=| .+\-]{1,160}$/.test(failure.required_sdk)
      && typeof failure.installed_sdk === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(failure.installed_sdk)
      && failure.installed_sdk.length <= 80) {
    return `[SDK_VERSION_MISMATCH] ${stage}\nApp requires PHP SDK: ${failure.required_sdk}\nServer PHP SDK: ${failure.installed_sdk}\nThe platform runtime does not satisfy this App's composer.json. Adjust App code and dependencies to APIs supported by the server SDK, then run nexia check. Do not lower the required version range without verifying compatibility. If the App needs newer APIs, the platform runtime must be updated. This is not an administrator approval request. Local composer install or deleting .nexia will not change the server SDK.\n`;
  }
  if (failure.code === 'DEPENDENCY_BUILD_FAILED' && failure.stage === 'dependencies') {
    return `[DEPENDENCY_BUILD_FAILED] ${stage}\nFix the reported PHP source location, or check composer.json against the supported PHP dependencies when no source location is reported. Run nexia check from the App folder and keep nexia dev running while correcting the source.\n`;
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
    return `[${failure.code}] ${stage}\n${causes[failure.code]}\n${files ? `${files}\n` : ''}No App code ran in this attempt. Do not reset data or delete migration history.\n`;
  }
  if (failure.code === 'PREPARATION_FAILED') {
    const action = { source: 'Check the App manifest and uploaded source.', catalog: 'Check App metadata and contribution declarations.',
      migrate: 'Check the App migrations; do not delete migration history or reset data.', initialize: 'Check App initialization code; preserve existing data.' };
    return `[PREPARATION_FAILED] ${stage}\n${Object.hasOwn(action, failure.stage) ? `${action[failure.stage]} ` : ''}Correct the App code for this step; development source watching continues.\n`;
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
  return 'Correct the reported issue and keep nexia dev running. Changed source is checked automatically; no administrator approval is required.';
}
