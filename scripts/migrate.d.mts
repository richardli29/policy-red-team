/**
 * Types for `migrate.mjs`.
 *
 * The runner is plain JavaScript because it has to run before anything is built
 * — `npm run migrate` on a fresh clone cannot depend on a bundle. The CLI and the
 * test setup both import it from TypeScript, so its shape is declared here rather
 * than the module being rewritten to satisfy them.
 */
/**
 * What the runner calls, and nothing more: PGlite has these three, and so does
 * the Lakebase adapter in `src/lib/db`.
 */
export type Migratable = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** The schema the tables live in, where it is not `public`. */
  schema?: string;
};

/** Apply every unapplied migration, in the order `migrations/order.txt` gives.
 *  Returns the names of the ones that ran. */
export function migrate(db: Migratable, options?: { log?: (message: string) => void }): Promise<string[]>;

/** The apply order, validated against what is on disk. */
export function plannedOrder(): Promise<string[]>;

/** A migration's SQL with `"public".` references pointed at `schema`. */
export function inSchema(sql: string, schema?: string): string;

/** True when a migration file carries its own BEGIN/COMMIT. */
export function wrapsItself(sql: string): boolean;
