import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { setupLocalDatabase } from '../src/local-database.js';

const port = Number(process.env.NEXIA_TEST_DB_PORT || 0);

test('local directory joins run with the existing App login and failed refresh preserves the snapshot', { skip: !port }, async t => {
  const id = randomUUID();
  const suffix = id.replaceAll('-', '');
  const database = 'nexia_test_directory_' + suffix;
  const credentials = { host: '127.0.0.1', port, user: 'postgres', password: 'fixture', database };
  const roles = { schema: 'dev_' + suffix, migrator: 'dev_m_' + suffix, runtime: 'dev_r_' + suffix };
  const binding = { database_name: database, id, roles, passwords: { migrator: 'a'.repeat(64), runtime: 'b'.repeat(64) },
    status: 'pending', allocated: false, directory_snapshot: true };
  const admin = new pg.Client({ ...credentials, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
  t.after(async () => {
    try {
      await admin.query(`DROP DATABASE ${pg.escapeIdentifier(database)} WITH (FORCE)`);
      for (const role of [roles.migrator, roles.runtime]) {
        await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(role)}`);
      }
    } finally { await admin.end(); }
  });

  const partyId = '9007199254740993';
  const publicId = randomUUID();
  const sitePublicId = randomUUID();
  let name = 'Directory member';
  let fail = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const table = path.split('/').at(-1);
    let payload;
    if (path.includes('/reference-keys/')) {
      payload = { table, keys: table === 'parties' ? [partyId] : [], next_after: null };
    } else if (path.includes('/directory/')) {
      assert.equal(url.searchParams.get('binding'), binding.id);
      const records = {
        parties: [{ key: fail ? 'invalid' : partyId, public_id: publicId, display_label: name, display_name: name }],
        sites: [{ key: '1', public_id: sitePublicId, label: 'Fixture site', status: 'active' }],
        site_roles: [{ key: '1', legal_entity_id: '2', site_id: '1', effective_from: '2026-01-01', effective_until: '2027-01-01' }],
      };
      payload = { table, rows: records[table] ?? [], next_after: null };
    } else if (path.endsWith('/ready')) {
      binding.status = 'ready';
      binding.allocated = true;
      payload = { binding };
    } else {
      payload = { binding };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { endpoint: 'http://127.0.0.1:' + server.address().port, token: 'fixture' };

  await setupLocalDatabase(config, 'app', credentials);
  const connect = async role => {
    const client = new pg.Client({ ...credentials, user: roles[role], password: binding.passwords[role] });
    await client.connect();
    return client;
  };
  const migrator = await connect('migrator');
  const schema = pg.escapeIdentifier(roles.schema);
  try {
    await migrator.query(`CREATE TABLE ${schema}.workers (id bigint PRIMARY KEY, party_id bigint REFERENCES public.parties(id))`);
    await migrator.query(`INSERT INTO ${schema}.workers VALUES (1, $1)`, [partyId]);
  } finally { await migrator.end(); }

  const runtime = await connect('runtime');
  try {
    const read = () => runtime.query(`SELECT directory.display_name FROM ${schema}.workers workers
      JOIN public.nexia_directory_parties directory ON directory.key = workers.party_id
      WHERE directory.display_name ILIKE 'Directory%' ORDER BY directory.display_name LIMIT 25`);
    assert.deepEqual((await read()).rows, [{ display_name: name }]);
    await assert.rejects(runtime.query('DELETE FROM public.nexia_directory_parties'), { code: '42501' });
    await assert.rejects(runtime.query('SELECT * FROM public.parties'), { code: '42501' });
    name = 'Directory updated';
    fail = true;
    await assert.rejects(setupLocalDatabase(config, 'app', credentials), /Invalid Core directory page/);
    assert.deepEqual((await read()).rows, [{ display_name: 'Directory member' }]);
    fail = false;
    await setupLocalDatabase(config, 'app', credentials);
    assert.deepEqual((await read()).rows, [{ display_name: name }]);
  } finally { await runtime.end(); }
});
