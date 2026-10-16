import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function run(command, args, { cwd, env, signal, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', value => { stdout += value; });
    child.stderr?.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, terminated) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const error = new Error(`${command} failed (${terminated || code}).${capture && stderr ? ` ${stderr.trim()}` : ''}`);
        error.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
        reject(error);
      }
    });
  });
}

/** Runs the App's own suite without Core, login or project scripts. */
export async function testApp(directory, options = {}, { execute = run, signal, log = console.error, environment = process.env } = {}) {
  const root = await realpath(directory);
  if (options.frontend) {
    if (options.database || options.testsuite) throw new Error('--frontend cannot be combined with --database or --testsuite.');
    const runner = 'node_modules/vitest/vitest.mjs';
    if (!await exists(path.join(root, runner))) throw new Error('Install this App’s Vitest development dependencies before running nexia test --frontend.');
    const args = [runner, 'run'];
    if (options.filter !== undefined) args.push('--testNamePattern', options.filter);
    log(`Test: ${root} (Vitest)`);
    await execute(process.execPath, args, { cwd: root, env: { ...environment, NODE_ENV: 'test' }, signal });
    return;
  }
  const config = (await exists(path.join(root, 'phpunit.xml'))) ? 'phpunit.xml' : 'phpunit.xml.dist';
  if (!await exists(path.join(root, config))) throw new Error('Add an independent phpunit.xml test suite to this App first.');
  const runner = (await exists(path.join(root, 'vendor/bin/pest'))) ? 'vendor/bin/pest' : 'vendor/bin/phpunit';
  if (!await exists(path.join(root, runner)) || !await exists(path.join(root, 'vendor/autoload.php'))) {
    throw new Error('Install this App’s development dependencies with composer install --no-scripts, then retry nexia test.');
  }
  const args = [runner, '--configuration', config, '--bootstrap', 'vendor/autoload.php', '--fail-on-empty-test-suite', '--do-not-cache-result'];
  for (const key of ['filter', 'testsuite']) if (options[key] !== undefined) args.push(`--${key}`, options[key]);
  const env = { ...environment, APP_ENV: 'testing' };
  let container, failure;
  try {
    if (options.database) {
      container = `nexia-test-${randomUUID()}`;
      await execute('docker', ['run', '--detach', '--rm', '--name', container,
        '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
        '--tmpfs', '/var/lib/postgresql/data:rw,nosuid', 'postgres:17-alpine'], { signal, capture: true });
      const mapping = await execute('docker', ['port', container, '5432/tcp'], { signal, capture: true });
      const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping.trim());
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('The disposable test database did not publish a loopback port.');
      Object.assign(env, { NEXIA_TEST_DB_HOST: '127.0.0.1', NEXIA_TEST_DB_PORT: match[1], DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1',
        DB_PORT: match[1], DB_DATABASE: 'postgres', DB_USERNAME: 'postgres', DB_PASSWORD: '' });
      delete env.DB_URL;
      delete env.DATABASE_URL;
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        signal?.throwIfAborted();
        try {
          await execute('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { signal, capture: true });
          ready = true;
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          await delay(250, undefined, { signal });
        }
      }
      if (!ready) throw new Error('The disposable test database was not ready within 15 seconds.');
    }
    log(`Test: ${root} (${config}${options.testsuite ? `, suite: ${options.testsuite}` : ''})`);
    await execute('php', args, { cwd: root, env, signal });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (container) {
      try { await execute('docker', ['rm', '--force', container], { capture: true }); }
      catch (error) {
        log(`Test database cleanup failed for ${container}: ${error.message}`);
        if (!failure) throw error;
      }
    }
  }
}
