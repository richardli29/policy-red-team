/**
 * The server.
 *
 * One process: the HTTP listener, the static client, and the worker that runs
 * assessments. Upstream splits those into a web container and a worker container
 * because several web replicas share one queue; here there is one of everything,
 * and a second process would be two things to start.
 *
 * IT BINDS TO LOOPBACK, AND THAT IS THE SECURITY MODEL. There is no session, no
 * password and no owner check per request, because the tool belongs to whoever is
 * at the machine. That is a reasonable design for something local and a terrible
 * one for something on a network, so binding anywhere else needs
 * `POLICY_HOST` set deliberately — and it says out loud what that means.
 */
/*
 * FIRST, AND THE ORDER IS THE POINT. `$lib/db` reads `POLICY_DATA_DIR` while it
 * is being evaluated, so a `.env` loaded any later than this is a `.env` that
 * does not decide where the database lives. See `src/lib/load-env.ts`.
 *
 * This file never loaded one at all, which made `cp .env.example .env` — the
 * README's first instruction — configure nothing.
 */
import { envFileLoaded } from '../src/lib/load-env';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/lib/polyfills';
import { handleApi, toHttpError } from './api';
import { crossSiteProblem } from '$lib/server/request-guard';
import { handleReader, readerDenied } from './reader-gate';
import { handleAdmin } from './admin';
import { requestOwner } from './owner';
import { ownedAnalysis } from '$lib/policy-analysis/server/store';
import { serveStatic } from './static';
import { sendJson } from './http';
import { client, DATA_DIR } from '$lib/db';
import { migrate } from '../scripts/migrate.mjs';
import { isTerminalStatus, runSignature, runWorker, WORKER_ID } from '$lib/worker';
import { releaseLeasesHeldBy } from '$lib/workflows/run-queue';
import { modelAccessProblem } from '$lib/llm/client';
import { proxyInUse } from '$lib/llm/providers/transport';
import { keyDir } from '$lib/policy-analysis/server/seal';
import { refreshModelMenu } from '$lib/server/models/offered-store';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT = path.join(ROOT, 'dist', 'client');

// `DATABRICKS_APP_PORT` is the one port Databricks Apps routes to, and it is
// assigned rather than chosen. `POLICY_PORT` still wins where both are set.
const PORT = Number(process.env.POLICY_PORT ?? process.env.DATABRICKS_APP_PORT ?? 5290);
const HOST = process.env.POLICY_HOST ?? '127.0.0.1';

/**
 * Who is watching which assessment, for the progress stream.
 *
 * Server-sent events rather than polling: a run emits a handful of updates over
 * several minutes, and a browser that asks every second for twenty minutes to
 * catch eighteen of them is doing the wrong shape of work.
 */
const watchers = new Map<string, Set<(event: string, data: unknown) => void>>();

function publish(analysisId: string, event: string, data: unknown): void {
  for (const send of watchers.get(analysisId) ?? []) send(event, data);
}

/*
 * WHAT A WATCHING BROWSER IS TOLD COMES FROM THE DATABASE, NOT FROM `drain`.
 *
 * `drain` used to publish every event. But `runWorker` claims the same queue in
 * the same process, so a stage the worker ran told nobody, and `drain` — finding
 * nothing to claim while the worker did the work, or while the run waited its
 * turn behind another — gave up after 120 seconds and published THAT as an
 * error, which the assessment page draws in place of everything else. The run
 * was fine; the page said it was not, and stopped updating. After a restart
 * nothing called `drain` at all, so a resumed run was never followed.
 *
 * So a follower reads the run's state every few seconds while anyone is
 * watching, publishes `stage` when it changes and `done` when it ends, and
 * stops when the last watcher leaves. The server no longer calls `drain` at
 * all: the worker loops below execute everything. `drain` is the CLI's.
 */
const FOLLOW_MS = 5_000;
const following = new Set<string>();

function follow(analysisId: string): void {
  if (following.has(analysisId)) return;
  following.add(analysisId);
  void (async () => {
    let last: string | null = null;
    try {
      while (watchers.get(analysisId)?.size) {
        const { status, signature } = await runSignature(analysisId).catch(() => ({ status: null, signature: last ?? '' }));
        if (last !== null && signature !== last && status) publish(analysisId, 'stage', { status });
        last = signature;
        if (status && isTerminalStatus(status)) {
          publish(analysisId, 'done', { status });
          return;
        }
        await new Promise((r) => setTimeout(r, FOLLOW_MS));
      }
    } finally {
      following.delete(analysisId);
    }
  })();
}

/*
 * NOTHING TO START. A created or resumed run is a `pending` row, and a worker
 * loop claims it within a second (`createPolicyWorker` polls every 1000 ms).
 * This used to start `drain()` as a second executor per submission, which is
 * how two runs came to execute at once by accident — sharing one worker id.
 * Running several at once is now a setting, `POLICY_WORKERS`, below.
 */
function startRun(_analysisId: string): void {}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    /*
     * `/health` IS EXEMPT FROM EVERY GATE, PERMANENTLY, and it says nothing.
     *
     * `scripts/deploy-porkserv.sh` verifies a deploy with `curl -fsS /health`
     * and nothing else, so a gate that covered it would fail the deploy that
     * installed it — and an exemption granted after the fact is one nobody
     * remembers is there. It is granted here, deliberately, and narrowed to the
     * one fact a health check needs.
     *
     * It used to list the ids of every assessment currently running, which is
     * information about the reader's work available to anyone who can reach the
     * port. A health check does not need it.
     */
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    /*
     * WHAT ANOTHER WEBSITE MAY MAKE THIS SERVICE DO.
     *
     * Before anything else that changes state. `POST /api/policy-analysis` takes
     * multipart, which is a CORS-simple request: no preflight, so any page the
     * reader visits can submit one and start a billable eighteen-stage run
     * against their quota. See `$lib/server/request-guard` for what this can and
     * cannot promise.
     */
    const crossSite = crossSiteProblem(req);
    if (crossSite) {
      sendJson(res, 403, { message: crossSite });
      return;
    }

    /*
     * WHO MAY READ THE ASSESSMENTS. Open by default, so no existing install
     * changes behaviour; a password where the operator has asked for one.
     *
     * IT GATES THE API AND NOT THE PAGE, and that is a decision rather than an
     * oversight. Every assessment, every passage of the paper and every export
     * is served from `/api/policy-analysis/*`; the client bundle is a few
     * hundred kilobytes of React that says nothing about anybody's work. Gating
     * the bundle as well would mean the sign-in page could not load the code
     * that draws the sign-in page — a service that can only be signed into by
     * somebody who is already signed in.
     *
     * So the data is behind the gate, the shell is not, and a reader who is not
     * signed in gets a page that asks them to.
     *
     * `/api/admin` is exempt because it has its own, stronger gate, and because
     * putting the configuration page behind the reader password would make a
     * forgotten reader password unrecoverable from the browser.
     */
    if (url.pathname.startsWith('/api/policy-analysis')) {
      const denied = await readerDenied(req);
      if (denied) {
        // No cache anywhere between here and the reader: a 401 that is cached
        // is a reader who cannot sign in, and a 200 that is cached is the gate
        // not existing.
        res.setHeader('cache-control', 'no-store');
        sendJson(res, 401, denied);
        return;
      }
    }

    // The progress stream. Held open, so it is handled before anything that
    // would try to end the response.
    if (url.pathname.startsWith('/api/policy-analysis/') && url.pathname.endsWith('/events')) {
      const id = url.pathname.split('/').at(-2)!;
      // Only the owner's own runs. Every other route reaches the store through
      // an owner; this one read the run by id alone.
      if (!(await ownedAnalysis(requestOwner(req), id))) {
        sendJson(res, 404, { message: 'No such assessment.' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // Without this, any proxy between here and the browser may buffer the
        // whole stream and deliver it when the run finishes — which is exactly
        // when nobody needs it any more.
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const set = watchers.get(id) ?? new Set();
      set.add(send);
      watchers.set(id, set);
      send('open', { id });
      follow(id);
      // A keep-alive comment every twenty seconds: a stream that says nothing for
      // minutes at a time is one that intermediaries close.
      const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(beat);
        set.delete(send);
        if (!set.size) watchers.delete(id);
      });
      return;
    }

    /*
     * THE ADMIN BRANCH, above the rest and gated inside itself.
     *
     * Note what is NOT here: no address check. Behind a tunnel every request
     * arrives from 127.0.0.1, so "local connections only" would pass for the
     * whole internet — the mistake that took the author's main site down for
     * 33 hours and exposed its admin area. `handleAdmin` requires a signed
     * cookie and nothing else.
     */
    // The reader gate's own door, which has to be reachable by somebody who has
    // not got through either gate.
    if (url.pathname.startsWith('/api/reader')) {
      const segments = url.pathname.replace(/^\/api\/reader\/?/, '').split('/').filter(Boolean);
      res.setHeader('cache-control', 'no-store');
      const handled = await handleReader(req, res, segments, req.method ?? 'GET');
      if (!handled) sendJson(res, 404, { message: 'No such endpoint.' });
      return;
    }

    if (url.pathname.startsWith('/api/admin')) {
      // A configuration payload must never sit in a cache between here and the
      // reader, and neither must a 401.
      res.setHeader('cache-control', 'no-store');
      const segments = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
      const handled = await handleAdmin(req, res, segments, req.method ?? 'GET');
      if (!handled) sendJson(res, 404, { message: 'No such endpoint.' });
      return;
    }

    if (url.pathname.startsWith('/api/policy-analysis')) {
      const handled = await handleApi(req, res, url, startRun);
      if (!handled) sendJson(res, 404, { message: 'No such endpoint.' });
      return;
    }

    if (await serveStatic(CLIENT, url.pathname, res)) return;
    sendJson(res, 404, { message: 'Not found.' });
  } catch (err) {
    const httpError = toHttpError(err);
    if (httpError.status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, httpError.status, { message: httpError.message });
    else res.end();
  }
});

/**
 * WHAT THIS PROCESS ACTUALLY RESOLVED, printed once at boot.
 *
 * Every line here is something that has already been diagnosed the slow way:
 * a `.env` the server never read, a data directory that was not where the file
 * said, a proxy the process had quietly stopped using, a Node below the floor
 * the package declares. Inside an estate somebody else runs, the first question
 * is always "is it reading my configuration?" — and the honest answer is cheap
 * to print and expensive to work out from the outside.
 *
 * NO VALUES, ONLY WHETHER AND WHERE. A proxy URL can carry credentials and this
 * goes to a log, so the proxy variables are reported as set or not. The same
 * posture the admin panel takes with a key.
 */
function bootReport(): void {
  const proxy = proxyInUse();
  const rows: [string, string][] = [
    ['node', `${process.version}${engineFloorMet() ? '' : `  (below the ${ENGINE_FLOOR} this package declares)`}`],
    ['.env', envFileLoaded ? 'read' : 'none found'],
    ['database', DATA_DIR],
    ['keys', keyDir()],
    ['proxy', proxy.https || proxy.http ? `set${proxy.noProxy ? `, with NO_PROXY` : ''}` : 'none'],
    ['extra CA', process.env.NODE_EXTRA_CA_CERTS ? process.env.NODE_EXTRA_CA_CERTS : 'none'],
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, value] of rows) console.log(`  ${name.padEnd(width)}  ${value}`);
}

const ENGINE_FLOOR = '22.23.2';

/**
 * Whether this Node is at or above the floor `package.json` declares.
 *
 * `src/lib/polyfills.ts` carries `Promise.try` and `Uint8Array.toHex` so the
 * suite runs on an older one, which is why this is a note rather than a refusal
 * — but a reader debugging a pdfjs failure should be told, not left to find the
 * `engines` field.
 */
function engineFloorMet(): boolean {
  const [major, minor, patch] = process.version.replace(/^v/, '').split('.').map(Number);
  const [fMajor, fMinor, fPatch] = ENGINE_FLOOR.split('.').map(Number);
  if (major !== fMajor) return major > fMajor;
  if (minor !== fMinor) return minor > fMinor;
  return patch >= fPatch;
}

await migrate(client, { log: () => {} });

/*
 * HOW MANY DOCUMENTS AT ONCE. Each loop runs one stage at a time and a run only
 * ever has one stage queued, so this is the number of assessments that can be
 * in progress together. Two by default: enough that a second paper does not
 * wait behind the first, without doubling the endpoint's load unasked. Each
 * run's own parallel calls come on top — see `concurrency` on the submit form.
 *
 * The loops also pick up anything left running by a previous process.
 */
const WORKERS = Math.min(6, Math.max(1, Number(process.env.POLICY_WORKERS) || 2));
const workers = Array.from({ length: WORKERS }, (_, slot) => runWorker((message) => console.log(`worker ${slot}: ${message}`), slot));
for (const worker of workers) worker.start();

server.listen(PORT, HOST, async () => {
  console.log(`Policy Red Team on http://${HOST}:${PORT}`);
  bootReport();
  // Said at startup rather than at the first failed assessment. Browsing,
  // reading old reports and downloading exports all work without a key; only a
  // new run needs one, and finding that out eighteen stages in is no way to
  // learn it.
  // Async now: which service answers is a configured thing, and reading the
  // configuration means reading the encrypted store.
  // The menu the panel chose, installed before anything can be commissioned.
  // The submit form's GET refreshes it anyway, but a POST straight at the API
  // after a restart would otherwise find the built-in five and quietly degrade a
  // model the reader had legitimately added to "the configured default".
  await refreshModelMenu();

  const problem = await modelAccessProblem();
  if (problem) {
    console.warn(`\n  ${problem}`);
    console.warn(`  Existing assessments still open and export; a new one will not start.\n`);
  }
  if (process.env.DATABRICKS_APP_NAME) {
    // Inside Databricks Apps nothing reaches this port except through the
    // platform's proxy, which has already required a workspace sign-in and
    // CAN_USE on the app. The warning below would be false here.
    console.log(`  bound to ${HOST} behind the Databricks Apps sign-in (${process.env.DATABRICKS_APP_NAME})`);
  } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(
      `\n  WARNING: bound to ${HOST}, not loopback.\n` +
        `  This service has no authentication of any kind. Anyone who can reach\n` +
        `  this port can read every assessment and start new ones against your key.\n`
    );
  }
});

/*
 * HOW LONG A STOP MAY WAIT FOR THE STAGE IN FLIGHT.
 *
 * On a server of its own there is no hurry: the systemd unit allows ten minutes,
 * and finishing a stage beats paying for it twice. Databricks Apps sends SIGKILL
 * fifteen seconds after SIGTERM, so there the claims are handed back at ten —
 * the next instance takes them within a second of starting, where it used to
 * wait out a sixty-second lease. The call in flight is lost either way; the
 * stage resumes. `POLICY_STOP_GRACE_MS` overrides both.
 */
const STOP_GRACE_MS = Number(process.env.POLICY_STOP_GRACE_MS) || (process.env.DATABRICKS_APP_NAME ? 10_000 : Infinity);
let stopping = false;

async function shutDown(handBack: boolean): Promise<never> {
  if (handBack) {
    const released = await releaseLeasesHeldBy(`${WORKER_ID}:`).catch(() => 0);
    if (released) console.log(`handed ${released} claimed stage(s) back to the queue for the next instance`);
  }
  server.close();
  await client.close().catch(() => {});
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(Number.isFinite(STOP_GRACE_MS)
      ? `\nstopping; the current stage has ${Math.round(STOP_GRACE_MS / 1000)}s to finish before it is handed back`
      : '\nstopping; the current stage will finish first');
    const finished = Promise.all(workers.map((worker) => worker.stop())).then(() => false);
    const timedOut = Number.isFinite(STOP_GRACE_MS)
      ? new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_GRACE_MS).unref())
      : new Promise<boolean>(() => {});
    void Promise.race([finished, timedOut]).then((handBack) => shutDown(handBack));
  });
}
