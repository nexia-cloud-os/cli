/** Only known diagnostics are rendered; old servers retain the existing recovery guidance. */
export function preparationFailureDetails(failure) {
  const stages = { source: 'source validation', database_probe: 'database access check', dependencies: 'PHP dependencies',
    catalog: 'App catalog', migrate: 'database migrations', initialize: 'App initialization', serve: 'backend startup',
    references: 'resource references', ingress: 'workspace routing', operator: 'platform preparation' };
  if (!failure || !Object.hasOwn(stages, failure.stage)) return '';
  const stage = `Failed step: ${stages[failure.stage]}.`;
  if (failure.code === 'SDK_VERSION_MISMATCH' && failure.stage === 'dependencies'
      && typeof failure.required_sdk === 'string' && /^[0-9vVxX*^~<>=| .+\-]{1,160}$/.test(failure.required_sdk)
      && typeof failure.installed_sdk === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(failure.installed_sdk)
      && failure.installed_sdk.length <= 80) {
    return `[SDK_VERSION_MISMATCH] ${stage}\nApp requires PHP SDK: ${failure.required_sdk}\nServer PHP SDK: ${failure.installed_sdk}\nThe platform runtime does not satisfy this App's composer.json. Contact developer support with these versions and the operation ID to confirm a compatible runtime. Local composer install or deleting .nexia will not change the server SDK.\n`;
  }
  if (failure.code === 'DEPENDENCY_BUILD_FAILED' && failure.stage === 'dependencies') {
    return `[DEPENDENCY_BUILD_FAILED] ${stage}\nCheck composer.json against the supported PHP dependencies. If it matches, contact developer support with the operation ID to inspect the server build. Private build output is not exposed.\n`;
  }
  if (failure.code === 'PREPARATION_FAILED') {
    const action = { source: 'Check the App manifest and uploaded source.', catalog: 'Check App metadata and contribution declarations.',
      migrate: 'Check the App migrations; do not delete migration history or reset data.', initialize: 'Check App initialization code; preserve existing data.' };
    return `[PREPARATION_FAILED] ${stage}\n${Object.hasOwn(action, failure.stage) ? `${action[failure.stage]} ` : ''}Contact developer support with the operation ID for the private failure details.\n`;
  }
  return '';
}
