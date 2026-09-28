/**
 * The database handle — PGlite, not a Postgres pool (except on Lakebase, below).
 *
 * Upstream this opens a `pg` connection pool against the site's shared server.
 * Here the database is embedded: real PostgreSQL compiled to WebAssembly, living
 * in one directory, with nothing to install and nothing to run alongside the app.
 * Phase 0 verified that the copied store layer's Postgres-specific SQL —
 * advisory locks, `jsonb ->>`, `::uuid`, `DESC NULLS LAST` — all behave (see
 * docs/phase-0.md).
 *
 * ONE CONNECTION, and that is the thing to hold on to. PGlite serialises every
 * query through a single connection, so the advisory locks in `store.ts` and the
 * `SELECT … FOR UPDATE` in `worker.ts` are satisfied without ever contending.
 * They are kept because they cost nothing and because a second writer would need
 * them, not because anything here races.
 */
import { drizzle } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { PGlite } from '@electric-sql/pglite';
import { createLakebasePool } from '@databricks/lakebase';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

/**
 * LAKEBASE, WHEN A DEPLOYMENT SAYS SO — and only when it says so explicitly.
 *
 * Databricks Apps has no persistent disk: a directory written there is gone on
 * the next restart or redeploy, and every assessment with it. So an app runs
 * against Lakebase Postgres, whose connection the platform injects (`PGHOST`,
 * `PGDATABASE`, `PGUSER`, `LAKEBASE_ENDPOINT`) and whose password is an OAuth
 * token `@databricks/lakebase` refreshes before it expires.
 *
 * `POLICY_DATABASE=lakebase` IS THE SWITCH, NOT THE PRESENCE OF `PGHOST`. The
 * integration suite and the browser walk purge and delete, and their guard is a
 * data directory they created. A `PGHOST` left in a developer's shell must not
 * be enough to point them at a real database; the harnesses clear this one.
 *
 * ITS OWN SCHEMA, because the app's service principal does not own `public` in
 * a database somebody else created, and because a schema is the unit that can
 * be granted, dumped and dropped whole.
 */
export const LAKEBASE = process.env.POLICY_DATABASE?.trim().toLowerCase() === 'lakebase';
const PG_SCHEMA = process.env.POLICY_PG_SCHEMA?.trim() || 'policy_red_team';
if (!/^[a-z_][a-z0-9_]*$/.test(PG_SCHEMA)) throw new Error(`POLICY_PG_SCHEMA must be a plain lower-case identifier, not ${PG_SCHEMA}`);

/** Where the database lives. Relative to the working directory so a clone runs
 *  without configuration; override for tests and for a packaged install. */
export const DATA_DIR = LAKEBASE
  ? `lakebase://${process.env.PGHOST ?? '(PGHOST unset)'}/${process.env.PGDATABASE ?? '(PGDATABASE unset)'} schema ${PG_SCHEMA}`
  : process.env.POLICY_DATA_DIR ?? path.join(process.cwd(), '.data', 'db');

/**
 * The raw handle the migration runner and the shutdown path use. PGlite's own
 * three methods — `exec`, `query`, `close` — are the whole of what they ask
 * for, so the pool is given the same three rather than teaching them both.
 */
type RawClient = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
  /** Named where the tables are not in `public`, for the migration runner. */
  schema?: string;
};

function lakebaseClient(): { raw: RawClient; pool: ReturnType<typeof createLakebasePool> } {
  const pool = createLakebasePool();
  // ON EVERY CONNECTION, NOT IN THE CONFIG. `createLakebasePool` builds its own
  // pg config and drops `options`, so `-c search_path=…` there is silently
  // ignored and every table lands in `public` — measured, 2026-09-24. A query
  // issued from `connect` is queued ahead of the borrower's first one.
  pool.on('connect', (conn) => {
    conn.query(`SET search_path TO "${PG_SCHEMA}"`).catch(() => {});
  });
  /*
   * A POOL WITHOUT AN `error` LISTENER KILLS THE PROCESS. `pg` emits `error`
   * for a failure on an idle connection, and an EventEmitter with nobody
   * listening throws it. On 2026-09-24 Lakebase's credential service answered a
   * token refresh with `504 DEADLINE_EXCEEDED` during a restart, and the app
   * went from running to CRASHED on that one transient answer. The connection
   * is discarded either way; the next query borrows a fresh one.
   */
  pool.on('error', (err) => {
    console.error(`lakebase: a pooled connection failed and was discarded: ${err instanceof Error ? err.message : String(err)}`);
  });
  const ready = pool.query(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`);
  // Surfaced by the first `exec` or `query` that awaits it — the migration run
  // at boot — not as an unhandled rejection that kills the process first.
  ready.catch(() => {});
  const raw: RawClient = {
    // ONE CONNECTION FOR A WHOLE FILE. A migration is `BEGIN; … COMMIT;` in one
    // string; if it fails, the connection is left inside an aborted transaction
    // and must be rolled back before it goes back to the pool, or the next
    // borrower inherits the failure.
    async exec(sql) {
      await ready;
      const conn = await pool.connect();
      try {
        return await conn.query(sql);
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    async query(sql, params) {
      await ready;
      return pool.query(sql, params) as never;
    },
    close: () => pool.end(),
    schema: PG_SCHEMA,
  };
  return { raw, pool };
}

function pgliteClient(): PGlite {
  // PGlite's Node filesystem creates its data directory but NOT the parents of
  // it, so a first run in a clean clone dies on `ENOENT: mkdir '.data/db'` — the
  // directory it is asked for, whose parent does not exist. Creating the tree
  // first is the whole fix.
  mkdirSync(DATA_DIR, { recursive: true });
  return new PGlite(DATA_DIR);
}

const lakebase = LAKEBASE ? lakebaseClient() : null;
const pglite = lakebase ? null : pgliteClient();

export const client: RawClient = lakebase ? lakebase.raw : (pglite as unknown as RawClient);

/*
 * TYPED AS THE PGLITE DATABASE IN BOTH CASES. The two drizzle drivers build the
 * same Postgres dialect through the same query builder, and `execute()` hands
 * back `{ rows }` from both — which is the one shape every raw call here reads.
 * Upstream ran this same code on `node-postgres`; PGlite was the substitution.
 */
export const db = lakebase
  ? (drizzlePg(lakebase.pool, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>)
  : drizzle(pglite!, { schema });

/**
 * Something that can run a statement: `db`, or the handle `db.transaction()`
 * passes its callback.
 *
 * A writer that closes over the `db` singleton cannot be composed — calling it
 * from inside `db.transaction(async (tx) => …)` runs it on a DIFFERENT
 * connection, so a rollback leaves its rows behind. Writers that take a
 * `DbExecutor` and default it to `db` compose without changing any call site.
 * (Upstream's words, and still true here even though the connection is one.)
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
