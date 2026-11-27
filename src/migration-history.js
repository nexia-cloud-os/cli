import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);

export async function checkMigrationHistory(directory, baseline) {
  const options = { cwd: directory, timeout: 10000 };
  let commit;
  try {
    const result = await git('git', ['rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`], options);
    commit = result.stdout.trim();
  } catch {
    throw new Error('Migration baseline is unavailable. Fetch the published App tag and run the check again.');
  }

  const { stdout } = await git('git', [
    'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--diff-filter=MDT', '--relative', commit, '--', 'database/migrations',
  ], options);
  if (stdout) {
    const files = stdout.split('\0').filter(Boolean).map(file => JSON.stringify(file));
    throw new Error(`Published migrations changed or were removed. Restore these files and add a new migration instead:\n${files.join('\n')}`);
  }
}
