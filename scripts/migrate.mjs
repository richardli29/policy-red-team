/**
 * The migration runner the source repository does not have.
 *
 * Its migrations are applied by hand, so three things had to be decided here:
 *
 *   ORDER comes from `migrations/order.txt`, not from the filenames. The two
 *   2026-09-09 files sort the wrong way round alphabetically.
 *
 *   TRANSACTIONS are mixed. Two of the eleven files open with `BEGIN;` and close
 *   with `COMMIT;`; the other nine are bare statements. Wrapping a file that
 *   already wraps itself gives a warning and an outer transaction that commits
 *   early, so each file is inspected and only the bare ones are wrapped.
 *
 *   IDEMPOTENCE is recorded in `_migrations`. The SQL is written defensively
 *   (`IF NOT EXISTS`, `EXCEPTION WHEN duplicate_object`) and would survive being
 *   re-run, but a ledger is how you tell "already applied" from "silently did
 *   nothing", and the fork will copy more migrations across in future.
 *
 * Usage: node scripts/migrate.mjs [dataDir]
 */
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIGRATIONS = path.join(ROOT, 'migrations');

/** Reads `order.txt`, ignoring comments and blank lines, and fails loudly if it
 *  disagrees with what is on disk — a copied migration that nobody listed is the
 *  failure this guards against. */
export async function plannedOrder() {
  const manifest = await readFile(path.join(MIGRATIONS, 'order.txt'), 'utf8');
  const listed = manifest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const onDisk = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const missing = listed.filter((f) => !onDisk.includes(f));
  const unlisted = onDisk.filter((f) => !listed.includes(f));
  if (missing.length) throw new Error(`order.txt names files that are not there: ${missing.join(', ')}`);
  if (unlisted.length) throw new Error(`migrations not named in order.txt: ${unlisted.join(', ')}`);
  return listed;
}

/** True when the file manages its own transaction and must not be wrapped. */
export function wrapsItself(sql) {
  return /^\s*BEGIN\s*;/im.test(sql);
}

/**
 * A migration's SQL, pointed at the schema the database handle names.
 *
 * Upstream's migrations name `"public"."policy_analyses"` in their foreign keys,
 * and they are copied files. On Lakebase this service lives in its own schema
 * (see `src/lib/db`), where `public` holds nothing of ours and the reference
 * would fail. Only the quoted, qualified form is rewritten — the one drizzle
 * generates — and only when a schema is named, so PGlite applies the files
 * byte for byte as before.
 */
export function inSchema(sql, schema) {
  if (!schema || schema === 'public') return sql;
  return sql.replaceAll('"public".', `"${schema}".`);
}

export async function migrate(db, { log = console.log } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS "_migrations" (
    "name" text PRIMARY KEY NOT NULL,
    "applied_at" timestamp with time zone DEFAULT now() NOT NULL
  );`);
  const done = new Set(
    (await db.query('select name from "_migrations"')).rows.map((r) => r.name)
  );
  const applied = [];
  for (const name of await plannedOrder()) {
    if (done.has(name)) { log(`  skip    ${name} (already applied)`); continue; }
    const sql = inSchema(await readFile(path.join(MIGRATIONS, name), 'utf8'), db.schema);
    const body = wrapsItself(sql) ? sql : `BEGIN;\n${sql}\nCOMMIT;`;
    try {
      await db.exec(body);
      await db.query('insert into "_migrations" (name) values ($1)', [name]);
      log(`  applied ${name}`);
      applied.push(name);
    } catch (err) {
      // PGlite leaves the session in a failed transaction; roll back so the
      // error message is about this migration and not the next one.
      await db.exec('ROLLBACK;').catch(() => {});
      throw new Error(`${name}: ${err.message}`);
    }
  }
  return applied;
}

// RUN AS A SCRIPT ONLY WHEN IT REALLY IS THE SCRIPT.
//
// `import.meta.url === \`file://${process.argv[1]}\`` is the usual idiom and it is
// wrong here: esbuild inlines this module into `dist/cli.js`, where import.meta.url
// becomes the BUNDLE's url — which is exactly `file://` + argv[1]. The block then
// fired inside the CLI and read argv[2] as a data directory, so `cli list` tried
// to migrate a database called "list". Checking the filename as well costs
// nothing and cannot be true inside a bundle.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` && /(^|\/)migrate\.mjs$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  const dataDir = process.argv[2] ?? path.join(ROOT, '.data', 'db');
  const db = new PGlite(dataDir);
  await db.waitReady;
  console.log(`migrating ${dataDir}`);
  await migrate(db);
  await db.close();
  console.log('done');
}
