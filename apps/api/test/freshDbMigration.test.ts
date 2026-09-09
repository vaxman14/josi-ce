// Fresh-database migration check: every migration applies in order to an empty
// database, and the columns this branch added are actually there afterwards.
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { testDb } from '../../../packages/core/test/helpers.js';

describe('a fresh database migrates cleanly', () => {
  it('applies every migration and lands the provider-ecosystem schema', async () => {
    const db = await testDb();
    const [cfg] = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'llm_providers' and column_name = 'provider_config'`,
    );
    expect(cfg?.column_name).toBe('provider_config');

    // The provider kinds added by 0031 must be accepted by the CHECK
    // constraint, or a provider selectable in the UI would be unsavable.
    for (const kind of ['bedrock', 'vertex_ai', 'azure_ai', 'ernie', 'hunyuan', 'cohere', 'gemini']) {
      // Every one of these is an external provider, and the schema refuses an
      // external row without the acknowledgment (M89) — which is the
      // constraint doing its job, so the fixture satisfies it rather than
      // working around it.
      await db.query(
        `insert into llm_providers
           (role, provider, model, external_acknowledged, external_acknowledged_at)
         values ('primary', $1, 'm', true, now())
         on conflict (role) do update set provider = excluded.provider`,
        [kind],
      );
    }
    const [row] = await db.query<{ provider: string }>(
      `select provider from llm_providers where role = 'primary'`,
    );
    expect(row.provider).toBe('gemini');
  });

  it('creates the backup destination table with no host-secret column', async () => {
    const db = await testDb();
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'backup_destination'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('credentials_enc');
    expect(names).toContain('bucket');
    // The credential is held by the application, sealed. There is deliberately
    // no column naming a file the operator must create and mount.
    expect(names).not.toContain('secret_prefix');
    expect(names).not.toContain('secret_file');
  });

  it('separates developer-service permission from developer-service connection', async () => {
    const db = await testDb();
    const policy = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'developer_service_policy'`,
    );
    const connections = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'developer_connections'`,
    );
    // Two tables, because "may connect" and "has connected" are two facts.
    expect(policy.map((c) => c.column_name)).toContain('mode');
    expect(connections.map((c) => c.column_name)).toContain('credentials_enc');
    // The credential is per person. A column for an installation-wide one would
    // be the admin-owned credential this design exists to avoid.
    expect(connections.map((c) => c.column_name)).toContain('owner_user_id');
    expect(policy.map((c) => c.column_name)).not.toContain('credentials_enc');

    // Every service ships refused.
    const modes = await db.query<{ service: string; mode: string }>(
      `select service, mode from developer_service_policy order by service`,
    );
    expect(modes).toHaveLength(4);
    expect(modes.every((m) => m.mode === 'not_allowed')).toBe(true);
  });

  it('stores a licence as a verifiable token, not as a granted flag', async () => {
    const db = await testDb();
    const cols = (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'licence'`,
    )).map((c) => c.column_name);
    expect(cols).toContain('token');
    // The cached verdict exists for display. What must NOT exist is a boolean
    // an operator could flip to license themselves: entitlement comes from a
    // signature, and the token is re-verified on every read.
    expect(cols).toContain('last_state');
    expect(cols).not.toContain('licensed');
    expect(cols).not.toContain('is_valid');
  });

  it('has no duplicate migration numbers introduced by this branch', () => {
    const files = readdirSync(join(import.meta.dirname, '../../../packages/db/migrations'))
      .filter((f) => f.endsWith('.sql'));
    const counts = new Map<string, string[]>();
    for (const f of files) {
      const n = f.slice(0, 4);
      counts.set(n, [...(counts.get(n) ?? []), f]);
    }
    const dupes = [...counts.entries()].filter(([, v]) => v.length > 1);
    // 0030 is duplicated on this branch already, from two features that landed
    // separately. Recorded rather than asserted away, so it is visible; what
    // this guards is that nothing NEW duplicates a number.
    expect(dupes.map(([n]) => n)).toEqual(['0030']);
  });
});
