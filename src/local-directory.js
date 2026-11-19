import pg from 'pg';
import { request } from './connection.js';

const projections = {
  parties: 'key bigint PRIMARY KEY, public_id uuid UNIQUE, display_label text, display_name text, legal_name text, person boolean, organization boolean, archived boolean, status text, merged_into_party_id bigint, deleted_at timestamptz',
  users: 'key bigint PRIMARY KEY, public_id uuid UNIQUE, display_label text, verified boolean, party_key bigint, deleted_at timestamptz',
  legal_entities: 'key bigint PRIMARY KEY, public_id uuid UNIQUE, display_label text, code text, party_public_id uuid, active boolean',
  operating_units: 'key bigint PRIMARY KEY, public_id uuid UNIQUE, display_label text, code text, parent_key bigint, classification text, accent_color text, status text, effective_from date, effective_until date',
  sites: 'key bigint PRIMARY KEY, public_id uuid UNIQUE, code text, label text, type text, timezone text, address jsonb, status text, effective_from date, effective_until date',
};

const relationName = table => 'nexia_directory_' + (['users', 'sites'].includes(table) ? 'query_' : '') + table;

export async function refreshLocalDirectory(client, config, route, binding) {
  const owner = 'nexia-directory:v1:' + binding.id;
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [owner]);
  try {
    // Stage every page before changing any view of the previous local snapshot.
    for (const [table, columns] of Object.entries(projections)) {
      const name = pg.escapeIdentifier(relationName(table));
      await client.query(`CREATE TEMP TABLE ${name} (${columns})`);
      let after = '0';
      for (;;) {
        const page = await request(config, `${route}/directory/${table}?binding=${binding.id}&after=${after}`);
        if (page.table !== table || !Array.isArray(page.rows) || page.rows.length > 250
            || page.rows.some((row, index) => typeof row?.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key)
              || BigInt(row.key) <= BigInt(index === 0 ? after : page.rows[index - 1].key))) {
          throw new Error('Invalid Core directory page.');
        }
        if (page.rows.length) {
          await client.query(`INSERT INTO pg_temp.${name} SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.${name}, $1::jsonb)`, [JSON.stringify(page.rows)]);
          after = page.rows.at(-1).key;
        }
        if (page.rows.length < 250 && page.next_after === null) break;
        if (page.rows.length !== 250 || page.next_after !== after) throw new Error('Invalid Core directory cursor.');
      }
    }

    await client.query('BEGIN');
    try {
      const runtime = pg.escapeIdentifier(binding.roles.runtime);
      const migrator = pg.escapeIdentifier(binding.roles.migrator);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
      for (const [table, columns] of Object.entries(projections)) {
        const relation = relationName(table);
        const name = pg.escapeIdentifier(relation);
        const existing = await client.query(`SELECT c.relkind, pg_get_userbyid(c.relowner) = current_user AS owned,
          obj_description(c.oid, 'pg_class') AS marker FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`, [relation]);
        const target = existing.rows[0];
        if (!target) {
          await client.query(`CREATE TABLE public.${name} (${columns})`);
          await client.query(`COMMENT ON TABLE public.${name} IS ${pg.escapeLiteral(owner)}`);
        } else if (target.relkind !== 'r' || !target.owned || target.marker !== owner) {
          throw new Error(`Local directory relation ${relation} needs operator review.`);
        }
        await client.query(`REVOKE ALL ON public.${name} FROM PUBLIC, ${migrator}, ${runtime}`);
        await client.query(`GRANT SELECT ON public.${name} TO ${runtime}`);
        await client.query(`DELETE FROM public.${name}`);
        await client.query(`INSERT INTO public.${name} SELECT * FROM pg_temp.${name}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [owner]);
  }
}
