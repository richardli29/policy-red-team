/**
 * WHAT THIS INSTALL IS CONFIGURED TO DO, AND THE CREDENTIALS THAT LET IT.
 *
 * Until now the answer was `.env`, which is right for a tool with one user who
 * has a shell on the machine and wrong for one that offers to connect a
 * subscription. This is the store behind the admin panel.
 *
 * ENCRYPTED AT REST, WITH THE KEY OUTSIDE THE DATABASE. The same AES-GCM as
 * everything else here — `encryptWith` from `$lib/secrets/crypto`, one
 * implementation rather than a second chance to get IV handling wrong — against
 * a key held in a 0600 file beside the sealed-run keys. That placement is the
 * point: a database dump, a nightly backup or a restic snapshot carries the
 * ciphertext and not the key, which is the property sealed runs already rely on.
 *
 * ENVIRONMENT STILL WINS. A value in `app.env` overrides anything stored here,
 * so a deployment managed by Ansible keeps behaving the way its files say it
 * does and nobody has to wonder which of two sources is live. The panel says
 * which is in force rather than pretending it owns the answer.
 *
 * A SECRET IS WRITE-ONLY from the outside. `readConfig` is server-side; the
 * panel gets `redact()` and nothing else, for the same reason the share token
 * was shown once: a value the server will read back out is a value that leaks
 * through every log and cache between here and the reader.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '$lib/db';
import { decryptWith, encryptWith } from '$lib/secrets/crypto';
import { keyDir } from '$lib/policy-analysis/server/seal';

/** Beside the per-run keys, and under the same 0700 directory. */
const settingsKeyPath = () => path.join(keyDir(), 'settings.key');

let cachedKey: Buffer | undefined;

/**
 * The key, minted on first use.
 *
 * `wx` so two writers racing on first boot cannot both mint one and leave the
 * loser's ciphertext unreadable — the same guard `mintKey` uses for a run.
 */
async function settingsKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  /*
   * FROM THE ENVIRONMENT, WHERE THE DISK DOES NOT LAST. Databricks Apps wipes
   * the filesystem on every restart, so a minted file would be a new key each
   * boot and every stored credential would read as unset. A deployment there
   * hands this in from a secret scope — still outside the database, which is
   * the property that matters.
   */
  const pinned = process.env.POLICY_SETTINGS_KEY?.trim();
  if (pinned) {
    if (!/^[0-9a-f]{64}$/i.test(pinned)) throw new Error('POLICY_SETTINGS_KEY must be 64 hex characters (32 bytes).');
    cachedKey = Buffer.from(pinned, 'hex');
    return cachedKey;
  }
  const file = settingsKeyPath();
  const existing = await readFile(file, 'utf8').catch(() => null);
  if (existing && /^[0-9a-f]{64}$/i.test(existing.trim())) {
    cachedKey = Buffer.from(existing.trim(), 'hex');
    return cachedKey;
  }
  await mkdir(keyDir(), { recursive: true, mode: 0o700 });
  await chmod(keyDir(), 0o700).catch(() => {});
  const minted = randomBytes(32);
  try {
    await writeFile(file, minted.toString('hex'), { flag: 'wx', mode: 0o600 });
    cachedKey = minted;
  } catch {
    // Somebody else won the race. Theirs is the key the ciphertext was written
    // with, so read it rather than keeping ours.
    const theirs = (await readFile(file, 'utf8')).trim();
    cachedKey = Buffer.from(theirs, 'hex');
  }
  return cachedKey;
}

/** Dropped between tests, and after a key directory changes underneath. */
export function clearSettingsKeyCache(): void {
  cachedKey = undefined;
}

type Row = { key: string; value: string };

async function rows(): Promise<Row[]> {
  const result = await db.execute(sql`select key, value from policy_settings`);
  return ((result as unknown as { rows: Row[] }).rows ?? []) as Row[];
}

/**
 * Everything stored, decrypted.
 *
 * A row that will not decrypt is DROPPED rather than thrown on: the likeliest
 * cause is a key file replaced or restored from a different machine, and a
 * service that refuses to start because one stale credential is unreadable is
 * worse than one that reports the credential as unset and lets the reader put
 * it back.
 */
export async function readAll(): Promise<Record<string, string>> {
  const key = await settingsKey();
  const out: Record<string, string> = {};
  for (const row of await rows()) {
    try {
      out[row.key] = decryptWith(key, row.value);
    } catch {
      /* unreadable: treat as unset */
    }
  }
  return out;
}

export async function readSetting(name: string): Promise<string | null> {
  return (await readAll())[name] ?? null;
}

export async function writeSetting(name: string, value: string): Promise<void> {
  const key = await settingsKey();
  const encrypted = encryptWith(key, value);
  await db.execute(sql`
    insert into policy_settings (key, value, updated_at) values (${name}, ${encrypted}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}

export async function deleteSetting(name: string): Promise<void> {
  await db.execute(sql`delete from policy_settings where key = ${name}`);
}

/** Namespaced so one provider's fields cannot collide with another's. */
export const providerSettingKey = (provider: string, field: string) => `provider.${provider}.${field}`;
export const ACTIVE_PROVIDER = 'provider.active';
export const ACTIVE_MODEL = 'provider.model';
