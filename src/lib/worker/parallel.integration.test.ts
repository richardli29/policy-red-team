/**
 * More than one document at once, on purpose.
 *
 * Until 2026-09-24 the server ran a stage executor per submission beside its
 * worker loop, sharing one worker id, and two runs executing together was an
 * accident nobody had tested. It is now a setting — `POLICY_WORKERS` loops, each
 * with its own id — and these are the properties it rests on:
 *
 *   - two loops claiming at the same moment get two different stages, never
 *     the same one and never nothing while work is waiting (`SKIP LOCKED`);
 *   - two loops take two assessments all the way to the end together;
 *   - a process handing its claims back on the way out returns only its own.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixtureModel } from '../../../tests/fixtures/policy-analysis/model';

vi.mock('$lib/policy-analysis/server/provider', () => ({
  modelCaller: () => async (stage: number, key: string, input: unknown) => fixtureModel(stage, key, input),
}));
vi.mock('$lib/policy-analysis/server/research', () => ({
  research: async () => ({ artefacts: [], warnings: ['Synthetic test: external research unavailable.'] }),
}));

const { createAnalysis } = await import('$lib/policy-analysis/server/store');
const { analysisStatus, isFinished, isTerminalStatus, runWorker } = await import('$lib/worker');
const { claimNext, clearLease, releaseLeasesHeldBy } = await import('$lib/workflows/run-queue');
const { TRIGGER } = await import('$lib/policy-analysis/contracts');
const { db } = await import('$lib/db');
const { sql } = await import('drizzle-orm');

const local =
  process.env.POLICY_LOCAL_TESTS === '1' &&
  /policy-test-[^/]+\/db$/.test(process.env.POLICY_DATA_DIR ?? '');

const bytes = readFileSync('tests/fixtures/policy-analysis/policy.txt');
// One owner per test: the store refuses a fourth active assessment per owner,
// and the claim test leaves its two behind.
const submit = (title: string, owner: string) =>
  createAnalysis(owner, {
    title, jurisdiction: null, policyArea: null, context: null,
    depth: 'standard' as const, model: null, thinkingLevel: null, concurrency: null,
    extraction: null, sharedContextFirst: false, sealed: false, sealedResearch: false,
    filename: 'policy.txt', mimeType: 'text/plain', bytes,
  });

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`not reached within ${timeoutMs}ms`);
}

describe.skipIf(!local)('several documents at once', () => {
  it('gives two simultaneous claims two different stages, and hands back only its own', async () => {
    await submit('Parallel claim one', 'claims@example.test');
    await submit('Parallel claim two', 'claims@example.test');
    await until(async () => {
      const res = await db.execute(sql`select count(*)::int as n from workflow_runs where status = 'pending' and trigger = ${TRIGGER} and started_at <= now()`);
      return ((res as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0) >= 2;
    }, 10_000);

    const [a, b] = await Promise.all([claimNext('test-a:0', 60_000, TRIGGER), claimNext('test-b:0', 60_000, TRIGGER)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);

    // Only the prefix given is released; the other claim stays held.
    expect(await releaseLeasesHeldBy('test-a:')).toBe(1);
    const rows = (await db.execute(sql`select id, status, claimed_by as "claimedBy" from workflow_runs where id in (${a!.id}, ${b!.id})`)) as unknown as { rows: { id: string; status: string; claimedBy: string | null }[] };
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId[a!.id]).toMatchObject({ status: 'pending', claimedBy: null });
    expect(byId[b!.id]).toMatchObject({ status: 'running', claimedBy: 'test-b:0' });

    // Put the second back too, so the next test starts from a clean queue.
    await releaseLeasesHeldBy('test-b:');
    await clearLease(b!.id, 'test-b:0');
  });

  it('takes two assessments to the end together with two loops', async () => {
    const workers = [runWorker(() => {}, 0), runWorker(() => {}, 1)];
    for (const worker of workers) worker.start();
    try {
      const [one, two] = await Promise.all([submit('Parallel run one', 'runs@example.test'), submit('Parallel run two', 'runs@example.test')]);
      await until(async () => {
        const [s1, s2] = await Promise.all([analysisStatus(one.id), analysisStatus(two.id)]);
        return !!s1 && !!s2 && isTerminalStatus(s1) && isTerminalStatus(s2);
      }, 50_000);
      expect(isFinished((await analysisStatus(one.id))!)).toBe(true);
      expect(isFinished((await analysisStatus(two.id))!)).toBe(true);
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  });
});
