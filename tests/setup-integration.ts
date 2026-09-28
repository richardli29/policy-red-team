/**
 * What an integration run needs before the first test: a migrated, throwaway
 * database and a throwaway key directory.
 *
 * THE DIRECTORY IS THE SAFETY GUARD. Upstream refuses to run these tests unless
 * `DATABASE_URL` points at its isolated Postgres on port 15435 — a regex, because
 * the cost of getting it wrong is a purge test running against real data. This
 * build has no connection string to inspect, so the same promise is kept a
 * different way: the data directory is created here, under the system temp
 * directory, and the tests refuse to run unless `POLICY_DATA_DIR` names a path
 * this file chose. Pointing the suite at a real install is not something you can
 * do by setting one variable.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import './../src/lib/polyfills';

const root = mkdtempSync(path.join(tmpdir(), 'policy-test-'));
process.env.POLICY_DATA_DIR = path.join(root, 'db');
process.env.POLICY_SEAL_KEY_DIR = path.join(root, 'keys');
process.env.POLICY_LOCAL_TESTS = '1';
// The other half of the guard: `POLICY_DATABASE=lakebase` in the shell would
// route every purge past the directory above and into a real database.
delete process.env.POLICY_DATABASE;

// Imported AFTER the environment is set: `src/lib/db` reads POLICY_DATA_DIR at
// module load and opens the database there, so importing it any earlier would
// open the developer's real one.
const { client } = await import('../src/lib/db');
const { migrate } = await import('../scripts/migrate.mjs');
await migrate(client, { log: () => {} });

afterAll(async () => {
  await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});
