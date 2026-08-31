// One thin database seam so CE runs identically on pglite (tests) and
// postgres.js (production). PostgreSQL only — there is no second dialect to
// keep happy, which is why this file is small.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** A value bound to a jsonb column.
 *
 * The two drivers want opposite things and neither complains when you get it
 * wrong. pglite wants a JSON *string* and parses it; postgres.js types a JS
 * string as text, so a pre-stringified payload reaches jsonb as a scalar string
 * — `'"{\"a\":1}"'` — not an object. That failure is silent in tests and
 * permanent in production.
 *
 * So call sites never serialize. They mark the value and each adapter does what
 * its own driver needs. */
export class JsonParam {
  constructor(readonly value: unknown) {}
}

/** Mark a value as destined for a jsonb column. Null/undefined become `{}`,
 * because every jsonb column in the schema is `not null default '{}'`. */
export function json(value: unknown): JsonParam {
  return new JsonParam(value ?? {});
}

/** Adapter for @electric-sql/pglite (tests). */
export function pgliteDb(pglite: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pglite.query(
        sql,
        params.map((p) => (p instanceof JsonParam ? JSON.stringify(p.value) : p)),
      );
      return res.rows as T[];
    },
  };
}

/** Adapter for porsager/postgres (production). Loosely typed on purpose:
 * postgres.js's generic rejects `unknown[]`, but every value bound here is a
 * JSON-serializable primitive. */
export function postgresDb(sql: unknown): Db {
  const client = sql as {
    unsafe: (q: string, params?: unknown[]) => Promise<unknown[]>;
    json?: (value: unknown) => unknown;
  };
  return {
    async query<T>(q: string, params: unknown[] = []): Promise<T[]> {
      const bound = params.map((p) => {
        if (!(p instanceof JsonParam)) return p;
        return client.json ? client.json(p.value) : p.value;
      });
      return (await client.unsafe(q, bound)) as T[];
    },
  };
}
