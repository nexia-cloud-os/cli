import pg from 'pg';
import { request } from './connection.js';

const tables = ['legal_entities', 'operating_units', 'parties', 'sites', 'users'];
const identifier = value => pg.escapeIdentifier(value);

export async function setupLocalDatabase(config, appId, { host = process.env.PGHOST || '127.0.0.1',
  port = Number(process.env.PGPORT || 5432), database = process.env.PGDATABASE,
  user = process.env.PGUSER, password = process.env.PGPASSWORD } = {}) {
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535
      || !/^[a-z][a-z0-9_]{0,62}$/.test(database ?? '') || !user || !password) {
    throw new Error('Start local PostgreSQL and create an empty dedicated database first; then set loopback PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD. See README: Database and submission.');
  }
  const route = `v2/apps/${appId}/local-database`;
  const response = await request(config, route, { method: 'POST', body: { database } });
  const binding = response.binding;
  if (binding?.database_name !== database || !/^[a-f0-9-]{36}$/.test(binding.id ?? '')) throw new Error('Local database binding changed.');
  if (!['pending', 'ready'].includes(binding.status) || !['schema', 'migrator', 'runtime'].every(key =>
    /^dev_(?:[mr]_)?[a-f0-9]{32}$/.test(binding.roles?.[key] ?? ''))
      || !['migrator', 'runtime'].every(key => /^[a-f0-9]{64}$/.test(binding.passwords?.[key] ?? ''))) {
    throw new Error('Invalid local database bootstrap response.');
  }
  const client = new pg.Client({ host, port, database, user, password, ssl: false, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const db = await client.query('SELECT current_database() AS name, current_user AS account');
    if (db.rows[0]?.name !== database || db.rows[0]?.account !== user) throw new Error('Local PostgreSQL identity changed.');
    const { schema, migrator, runtime } = binding.roles;
    const existing = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [[migrator, runtime]]);
    if (existing.rows.length !== 0 && existing.rows.length !== 2) throw new Error('Only one of the App database roles exists; inspect it before retrying.');
    if (existing.rows.length === 0) {
      if (binding.allocated !== false) throw new Error('Previously allocated local App roles are missing; inspect the database before retrying.');
      await client.query('BEGIN');
      try {
        await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        for (const role of [migrator, runtime]) {
          await client.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(binding.passwords[role === migrator ? 'migrator' : 'runtime'])}`);
          await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(role)}`);
        }
        await client.query(`CREATE SCHEMA ${identifier(schema)} AUTHORIZATION ${identifier(migrator)}`);
        await client.query(`REVOKE ALL ON SCHEMA ${identifier(schema)} FROM PUBLIC`);
        await client.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(runtime)}`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(migrator)} IN SCHEMA ${identifier(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier(runtime)}`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(migrator)} IN SCHEMA ${identifier(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${identifier(runtime)}`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    const roles = await client.query('SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])', [[migrator, runtime]]);
    if (roles.rows.length !== 2 || roles.rows.some(row => !row.rolcanlogin || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls)) throw new Error('Local App roles need operator review.');
    const owner = await client.query('SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1', [schema]);
    if (owner.rows[0]?.rolname !== migrator) throw new Error('Local App schema owner changed.');
    if (existing.rows.length === 2) {
      await client.query(`ALTER ROLE ${identifier(migrator)} PASSWORD ${pg.escapeLiteral(binding.passwords.migrator)}`);
      await client.query(`ALTER ROLE ${identifier(runtime)} PASSWORD ${pg.escapeLiteral(binding.passwords.runtime)}`);
    }
    for (const table of tables) {
      const name = identifier(table);
      await client.query(`CREATE TABLE IF NOT EXISTS public.${name} (id bigint PRIMARY KEY)`);
      const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', ['public', table]);
      if (columns.rows.length !== 1 || columns.rows[0].column_name !== 'id') throw new Error(`Local Core reference table ${table} is not key-only.`);
      await client.query(`GRANT REFERENCES (id) ON public.${name} TO ${identifier(migrator)}`);
    }
    // shortcut: retired Core keys remain to preserve local foreign keys; resync by rerunning db local when Core creates new keys.
    for (const table of tables) {
      let after = '0';
      for (;;) {
        const page = await request(config, `${route}/reference-keys/${table}?after=${after}`);
        if (page.table !== table || !Array.isArray(page.keys) || page.keys.length > 1000
            || page.keys.some((key, index) => typeof key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(key)
              || BigInt(key) <= BigInt(index === 0 ? after : page.keys[index - 1]))) throw new Error('Invalid Core reference key page.');
        if (page.keys.length) {
          await client.query(`INSERT INTO public.${identifier(table)} (id) SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING`, [page.keys]);
          after = page.keys.at(-1);
        }
        if (page.next_after === null) break;
        if (page.next_after !== after || page.keys.length !== 1000) throw new Error('Invalid Core reference key cursor.');
      }
    }
  } finally { await client.end(); }
  const ready = binding.status === 'ready' ? { binding } : await request(config, `${route}/ready`, { method: 'POST', body: {} });
  if (ready.binding?.id !== binding.id || ready.binding.status !== 'ready') throw new Error('Local database readiness was not confirmed.');
  return ready.binding;
}
