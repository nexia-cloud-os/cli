import { InputError } from './commands.js';
import { message } from './input.js';

export const MAX_DEV_APPS = 20;
export const filterDevApps = (apps, selectors) => selectors === undefined ? apps
  : apps.filter(app => Array.isArray(selectors) ? selectors.includes(app.key)
    : app.name === selectors || app.key === selectors);

export async function selectDevApps(apps, selectors, input) {
  if (selectors !== undefined) {
    const keys = new Set();
    for (const selector of [selectors].flat()) {
      const matches = filterDevApps(apps, selector);
      if (matches.length !== 1) throw new InputError(`Unknown or ambiguous App: ${selector}. Available: ${apps.map(app => app.name).join(', ')}`);
      keys.add(matches[0].key);
    }
    if (!keys.size || keys.size > MAX_DEV_APPS) throw new InputError(`Select 1–${MAX_DEV_APPS} Apps with repeated --app.`);
    return [...keys];
  }
  if (apps.length > 1 && input.interactive) {
    return (await input.multiChoice(message('Choose Apps to develop', '개발할 앱을 선택하세요'),
      apps.map(app => ({ value: app.key, label: app.name })), { max: MAX_DEV_APPS })) ?? undefined;
  }
  if (apps.length > MAX_DEV_APPS) throw new InputError(`A project development connection supports at most ${MAX_DEV_APPS} local Apps. Repeat --app to select Apps, or run nexia dev in an interactive terminal.`);
  return undefined;
}
