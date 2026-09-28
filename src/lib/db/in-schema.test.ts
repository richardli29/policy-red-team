import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { inSchema, plannedOrder } from '../../../scripts/migrate.mjs';

describe('a migration pointed at its own schema', () => {
  it('rewrites the qualified references drizzle writes, and nothing else', () => {
    const sql = 'REFERENCES "public"."policy_analyses"("id"); -- public is a word';
    expect(inSchema(sql, 'policy_red_team')).toBe('REFERENCES "policy_red_team"."policy_analyses"("id"); -- public is a word');
  });

  it('leaves the files byte for byte where no schema is named, which is PGlite', () => {
    const sql = 'REFERENCES "public"."policy_analyses"("id")';
    expect(inSchema(sql, undefined)).toBe(sql);
    expect(inSchema(sql, 'public')).toBe(sql);
  });

  it('leaves no reference to public in any shipped migration once rewritten', async () => {
    for (const name of await plannedOrder()) {
      const sql = await readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
      expect(inSchema(sql, 'policy_red_team'), name).not.toMatch(/"public"\./);
    }
  });
});
