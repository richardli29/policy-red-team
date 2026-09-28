/**
 * The run queue, for the worker loops in one process.
 *
 * Upstream this coordinates a FLEET: `SELECT … FOR UPDATE SKIP LOCKED` so several
 * workers can poll the same table without ever being handed the same row, leases
 * that expire so a worker dying mid-run returns its claim, a heartbeat reaper,
 * and a carve-out deciding whether the site's generic worker or the dedicated
 * policy worker owns a policy run. A standalone install has one worker, one
 * process and one connection, so all of that is machinery against a race that
 * cannot happen.
 *
 * What is KEPT, and why:
 *
 *   The lease columns, because the copied cancel, purge and progress paths in
 *   `server/store.ts` read them, and because a lease that is visibly held is how
 *   a crashed run is told from a running one on restart.
 *
 *   `started_at <= now()`, because it is not a fleet feature — it is how the
 *   pipeline SCHEDULES ITSELF. `store.ts` enqueues the next stage with
 *   `startedAt: now + delayMs`, and a claim that ignored it would run every stage
 *   immediately and defeat the pacing.
 *
 *   `SKIP LOCKED`, which was dropped as "nothing to skip past on a single
 *   connection" and is back since 2026-09-24. On Lakebase there is a real pool,
 *   and the server runs several worker loops so that more than one document can
 *   be assessed at once. Without it two loops claiming at the same moment
 *   queue on the same row, and the one that waits gets nothing — even with
 *   another stage ready behind it. PGlite accepts it and has nothing to skip.
 *
 * What is DROPPED: the worker-ownership carve-out (there is one owner).
 */
import { sql } from 'drizzle-orm';
import { db } from '$lib/db';

/** How long a claimed run's lease runs before another claim may take it. */
export const DEFAULT_LEASE_MS = 60_000;

/** What the worker needs to execute a claimed run. */
export interface ClaimedRun {
  id: string;
  workflowId: string;
  trigger: string;
  /** The run's persisted initial input, or null for runs enqueued without one. */
  input: Record<string, unknown> | null;
}

function rowsOf<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? [];
}

function countOf(res: unknown): number {
  return (res as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Take the next runnable row, mark it running and stamp a lease.
 *
 * Returns null when nothing is due — which is the common case, because a stage
 * enqueued with a delay is not due yet.
 */
export async function claimNext(
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  triggerFilter?: string,
  runIdFilter?: string,
): Promise<ClaimedRun | null> {
  const leaseSeconds = Math.max(1, Math.round(leaseMs / 1000));
  const res = await db.execute(sql`
    WITH next AS (
      SELECT id
      FROM workflow_runs
      WHERE status = 'pending'
        AND ${triggerFilter ? sql`trigger = ${triggerFilter}` : sql`true`}
        AND ${runIdFilter ? sql`id = ${runIdFilter}` : sql`true`}
        AND (trigger <> 'policy-analysis' OR started_at <= now())
        AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY started_at ASC NULLS FIRST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE workflow_runs r
    SET status = 'running',
        claimed_by = ${workerId},
        claimed_at = now(),
        lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
        started_at = COALESCE(r.started_at, now()),
        heartbeat_at = now()
    FROM next
    WHERE r.id = next.id
    RETURNING r.id AS id, r.workflow_id AS "workflowId", r.trigger AS trigger, r.input_data AS input
  `);
  return rowsOf<ClaimedRun>(res)[0] ?? null;
}

/** Extend the lease on a run this worker still owns. Best effort: a row taken
 *  by someone else is left alone. */
export async function renewLease(
  runId: string,
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const leaseSeconds = Math.max(1, Math.round(leaseMs / 1000));
  const res = await db.execute(sql`
    UPDATE workflow_runs
    SET lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
        heartbeat_at = now()
    WHERE id = ${runId} AND claimed_by = ${workerId}
  `);
  return countOf(res) > 0;
}

/** Clear the lease on a finished run, whatever its terminal status. */
export async function clearLease(runId: string, workerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE workflow_runs
    SET claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE id = ${runId} AND claimed_by = ${workerId}
  `);
}

/**
 * Re-offer rows whose lease lapsed.
 *
 * On a single-process build the case this covers is a CRASH: the process died
 * holding a claim, and on restart the row is still marked running with a lease
 * nobody will renew. Returns the number of rows released.
 */
export async function releaseExpiredLeases(triggerFilter?: string): Promise<number> {
  await db.execute(sql`
    UPDATE workflow_runs
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE trigger = 'policy-analysis' AND status = 'running' AND lease_expires_at <= now()
  `);
  const res = await db.execute(sql`
    UPDATE workflow_runs
    SET claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE status = 'pending'
      AND ${triggerFilter ? sql`trigger = ${triggerFilter}` : sql`true`}
      AND claimed_by IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= now()
  `);
  return countOf(res);
}

/**
 * Hand back every run this process holds, now, on the way out.
 *
 * Databricks Apps gives a stopping process fifteen seconds and a stage can
 * take minutes, so a restart used to leave its claims to lapse: the next
 * instance waited out the lease before anything moved, and the call in flight
 * showed as failed with no reason. Returning them as `pending` lets the next
 * instance claim them within a second of starting. `claimed_by` is matched on
 * the process's own prefix, so another process's claims are never touched.
 */
export async function releaseLeasesHeldBy(workerPrefix: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE workflow_runs
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE status = 'running' AND claimed_by LIKE ${`${workerPrefix}%`}
  `);
  return countOf(res);
}
