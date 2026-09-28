/**
 * Running the queue.
 *
 * Two shapes, because two callers want different things:
 *
 *   `drain(analysisId)` — run stages until ONE assessment reaches a terminal
 *   state, then return. This is what the CLI wants: a command that finishes.
 *
 * BOTH RENEW THEIR LEASE. A claim is good for `LEASE_MS` and a real stage takes
 * minutes, so work that does not renew is swept back to `pending` mid-flight by
 * the reaper — and reported as a provider outage, because from inside the call
 * that is exactly what it looks like. `drain` did not renew until 2026-09-19.
 *
 *   `runWorker()` — the long-running loop, for phase 4's server. It is upstream's
 *   `createPolicyWorker`, copied verbatim, with its dependencies wired to this
 *   build's queue. The loop already handles lease renewal, returning an
 *   interrupted envelope for recovery, and draining the current stage on stop;
 *   there was no reason to write a second one.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { policyAnalyses, policyStages } from '$lib/db/schema';
import { claimNext, clearLease, releaseExpiredLeases, renewLease } from '$lib/workflows/run-queue';
import { executePolicyRun } from '$lib/policy-analysis/server/worker';
import { TRIGGER } from '$lib/policy-analysis/contracts';
// Relative rather than aliased: the file sits at its upstream path so
// `scripts/sync-core.mjs` can keep proving it is a verbatim copy.
import { createPolicyWorker, type PolicyQueueRun } from '../../../packages/jkai-policy-worker/src/loop';

/**
 * Statuses an assessment does not come back from without a control action.
 *
 * `completed_with_gaps` is the one to know about, and guessing this list rather
 * than reading it cost a 120-second hang on the first real run. It is not a
 * failure: `store.ts` picks between `completed` and `completed_with_gaps` purely
 * on whether any stage recorded a warning, and a run with no Tavily key always
 * warns, because the research stage says so rather than pretending it searched.
 * Five places in the copied code treat the pair as one, and so does this.
 */
const FINISHED = ['completed', 'completed_with_gaps'] as const;
const TERMINAL = new Set<string>([...FINISHED, 'failed', 'cancelled']);

/** Did the assessment finish, gaps or not? */
export function isFinished(status: string): boolean {
  return (FINISHED as readonly string[]).includes(status);
}

/*
 * UNIQUE PER PROCESS, not just per pid. In a container the pid is often the same
 * on every instance, and during a redeploy the old instance and the new one
 * overlap: the old one handing back "its" claims by pid would hand back the new
 * one's too. A random part makes the prefix this process's alone.
 */
export const WORKER_ID = `local:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * How long a claim is good for, and therefore how often it must be renewed.
 *
 * Named because the claim and the renewal have to agree: a lease shorter than
 * the renewal interval is swept while the work is still running, which is the
 * failure this constant exists to make impossible to reintroduce.
 */
const LEASE_MS = 60_000;

export async function analysisStatus(analysisId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: policyAnalyses.status })
    .from(policyAnalyses)
    .where(eq(policyAnalyses.id, analysisId));
  return row?.status ?? null;
}

/**
 * `drain` stopped waiting, while the assessment itself is still going.
 *
 * Its own class because it is not a failure of the run, and a caller that shows
 * errors to a reader has to be able to tell. In the server a second executor —
 * `runWorker` — claims the same queue, so `drain` can find nothing to claim for
 * minutes on end while every stage is being done: behind another assessment
 * (`queued`), or because the stage in flight is the worker's (`running`). On
 * 2026-09-24 that was shown to a reader as the whole of their assessment page.
 */
export class DrainIdle extends Error {
  constructor(readonly analysisId: string, readonly status: string, idleTimeoutMs: number) {
    super(`Nothing became claimable for ${Math.round(idleTimeoutMs / 1000)}s while ${analysisId} was still "${status}".`);
    this.name = 'DrainIdle';
  }
}

/**
 * Where an assessment is, in one comparable value: its status and every stage's.
 * It changes exactly when something a reader watching the run would see changes,
 * whichever loop did the work.
 */
export async function runSignature(analysisId: string): Promise<{ status: string | null; signature: string }> {
  const status = await analysisStatus(analysisId);
  const stages = await db
    .select({ ordinal: policyStages.ordinal, status: policyStages.status })
    .from(policyStages)
    .where(eq(policyStages.analysisId, analysisId));
  const signature = stages
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((stage) => stage.status)
    .join(',');
  return { status, signature: `${status}|${signature}` };
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export interface DrainOptions {
  /** Called after each stage, for progress output. */
  onStage?: (info: { completed: number; status: string }) => void;
  /** Give up rather than spin forever if the queue stops producing work. */
  idleTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Run stages until this assessment is finished.
 *
 * The idle timeout is the thing to understand. A stage is enqueued with a DELAY
 * — `store.queueStage` sets `started_at` in the future to pace the pipeline — so
 * `claimNext` returning null usually means "not yet", not "nothing left". The
 * loop therefore waits rather than exiting on the first empty claim, and only
 * gives up if nothing becomes claimable for the whole idle window.
 */
export async function drain(analysisId: string, options: DrainOptions = {}): Promise<string> {
  const { onStage, idleTimeoutMs = 120_000, pollMs = 250 } = options;
  let completed = 0;
  let idleSince = Date.now();

  for (;;) {
    const status = await analysisStatus(analysisId);
    if (status === null) throw new Error(`No assessment ${analysisId}`);
    if (TERMINAL.has(status)) return status;

    await releaseExpiredLeases(TRIGGER);
    const claimed = await claimNext(WORKER_ID, LEASE_MS, TRIGGER);
    if (!claimed) {
      if (Date.now() - idleSince > idleTimeoutMs) {
        throw new DrainIdle(analysisId, status, idleTimeoutMs);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    idleSince = Date.now();
    /*
     * KEEP THE LEASE ALIVE WHILE THE STAGE RUNS.
     *
     * This claim is for 60 seconds and a real stage takes minutes. Nothing
     * renewed it, so 60 seconds in, `releaseExpiredLeases` — called by this
     * loop's own next iteration, and by `runWorker`'s sweep, which the server
     * runs at the same time — set the row back to `pending` and cleared the
     * claim out from under work that was still in flight. The call then died
     * and was reported as "the configured model provider could not be reached",
     * naming the provider for a fault that was entirely ours.
     *
     * It is why no real assessment ever completed. Every stage of a real paper
     * runs past a minute; every stage of the fixture finishes well inside one,
     * so the walk, the integration tests and the CLI all passed throughout.
     *
     * `runWorker` never had this bug — `createPolicyWorker` takes a `renew`
     * callback and uses it. `drain` is the one that was written here.
     */
    const renewal = setInterval(() => {
      void renewLease(claimed.id, WORKER_ID, LEASE_MS).catch(() => {});
    }, LEASE_MS / 3);
    try {
      await executePolicyRun(claimed, WORKER_ID);
      completed++;
      onStage?.({ completed, status: (await analysisStatus(analysisId)) ?? status });
    } finally {
      clearInterval(renewal);
      await clearLease(claimed.id, WORKER_ID);
    }
  }
}

/**
 * The long-running loop, for phase 4's server. One per SLOT.
 *
 * Each loop claims one stage at a time, and an assessment only ever has one
 * stage queued, so N loops is up to N documents in progress at once — each
 * with its own parallel calls inside a stage. Every loop has its own id: they
 * used to share `WORKER_ID`, which is how a second executor could renew or
 * clear a claim that was not its own.
 */
export function runWorker(log: (message: string) => void = () => {}, slot = 0) {
  const id = `${WORKER_ID}:${slot}`;
  return createPolicyWorker({
    claim: () => claimNext(id, LEASE_MS, TRIGGER),
    execute: (run: PolicyQueueRun) => executePolicyRun(run, id),
    renew: (run: PolicyQueueRun) => renewLease(run.id, id),
    clear: (run: PolicyQueueRun) => clearLease(run.id, id),
    recover: async () => { await releaseExpiredLeases(TRIGGER); },
    sweep: () => releaseExpiredLeases(TRIGGER),
    log,
  });
}
