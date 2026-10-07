/**
 * The API the client talks to.
 *
 * Upstream this is a dozen SvelteKit route files under `src/routes/api/policy-analysis`.
 * The shapes are kept — `GET /api/policy-analysis/:id` still returns what
 * `detail()` returns — so the client is written against the same contract and a
 * future divergence is a deliberate one rather than a drift.
 *
 * WHAT IS NOT HERE IS THE POINT: no session, no allow-list, no owner check per
 * request. Upstream needs all three because the policy tool lives inside a public
 * site. This build binds to loopback and belongs to whoever is sitting at the
 * machine — see `server/index.ts`, which refuses to listen anywhere else without
 * being told twice.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, readMultipart, sendJson } from './http';
import { requestOwner } from './owner';
import { isReadOnly, READ_ONLY_MESSAGE } from '$lib/server/read-only';
import { rateLimit } from '$lib/server/rate-limit';

/**
 * Persona enquiries, serialised per owner.
 *
 * A promise chain rather than a lock, because this server is one process and the
 * thing being protected is a read-modify-write that spans a minute of model
 * calls. A rejected run must not break the chain for the next caller, hence the
 * swallowed `catch`.
 */
const researchQueues = new Map<string, Promise<unknown>>();
function queueResearch<T>(owner: string, run: () => Promise<T>): Promise<T> {
  const previous = researchQueues.get(owner) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  researchQueues.set(owner, next.catch(() => undefined));
  return next;
}
import { commissionableModels, refreshModelMenu } from '$lib/server/models/offered-store';
import { runProgress } from '$lib/server/progress';
import { readSubmission, readMaterial } from '$lib/policy-analysis/server/ingest';
import {
  addMaterial, control, detail, listAnalyses, ownedAnalysis, purge, restate,
} from '$lib/policy-analysis/server/store';
import { census } from '$lib/policy-analysis/server/census';
import { buildReceipt } from '$lib/policy-analysis/receipt';
import { keyDir } from '$lib/policy-analysis/server/seal';
import { PolicyError } from '$lib/policy-analysis/validation';
import { assessmentDocument, isDownloadFormat, isExportFormat } from '$lib/policy-analysis/server/export';
import { assessmentBundle } from '$lib/policy-analysis/server/bundle';
import { ownerPayload, sharedPayload } from '$lib/policy-analysis/offline/payload';
import { runFacts, type PackPayload } from '$lib/offline-run';
import { forProgress, forTheReport } from '$lib/detail-views';
import { shareableReport } from '$lib/policy-analysis/share';
import { STAGES } from '$lib/policy-analysis/contracts';
import { analysisStatus } from '$lib/worker';


/**
 * The copied export layer returns a web `Response`; this server speaks
 * `node:http`. Rather than rewrite `assessmentDocument` and `assessmentBundle` —
 * both verbatim copies, and both carrying content-disposition headers that took
 * real care to get right — the two are bridged here, once.
 */
async function pipeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/**
 * A `PolicyError` is the pipeline telling the reader something they can act on —
 * the file is not a PDF, the paper is too long, three assessments are already
 * running. Those are 400s with the message shown as written. Anything else is a
 * fault of ours and says so without leaking its innards.
 */
/**
 * A reader closing a tab is not a fault.
 *
 * The persona enquiry passes the request's abort through to the model calls so
 * that closing the tab stops the spend — which is the right behaviour, and which
 * made every such close log a 500 with a full stack. An `AbortError` is neither
 * `HttpError` nor `PolicyError`, so it fell to the bottom branch and looked like
 * a crash in the log of a service whose log is read.
 */
const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof PolicyError) return new HttpError(400, err.message);
  // 499 is nginx's "client closed request": nothing is listening for it, and it
  // keeps a cancellation out of the 5xx that mean something went wrong here.
  if (isAbort(err)) return new HttpError(499, 'The request was cancelled.');
  return new HttpError(500, 'Something went wrong handling that. The server log has the detail.');
}

/**
 * A FormData-alike, because `readSubmission` takes a Request and we have a form.
 *
 * THE FILE GOES BACK UNDER THE NAME IT ARRIVED WITH. It used to go back as
 * `document` whatever the form called it, which is right for a submission and
 * wrong for material — `readMaterial` looks for `material`, found nothing, and
 * answered "attach a document or paste its text" to a reader who had attached
 * one. The route had existed since phase 4 with nothing driving it.
 */
function asRequest(fields: Record<string, string>, file?: { field: string; filename: string; mimeType: string; bytes: Buffer }): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) {
    form.set(file.field || 'document', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.filename);
  }
  return new Request('http://localhost/api/policy-analysis', { method: 'POST', body: form });
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  onStarted: (analysisId: string) => void
): Promise<boolean> {
  const segments = url.pathname.replace(/^\/api\/policy-analysis\/?/, '').split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  // WHOSE PAPERS. Resolved once, before any route, so every store call below is
  // scoped to the person signed in when `POLICY_OWNER_SCOPE=user`. See `owner.ts`.
  const signedIn = requestOwner(req);
  const owner = () => signedIn;

  // One gate for every mutation, rather than a check per handler. A route added
  // later is covered without anyone remembering to cover it — which is the only
  // version of this that stays true.
  if (isReadOnly() && method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(403, READ_ONLY_MESSAGE);
  }

  // GET /api/policy-analysis — the history list, plus what the submit form needs
  // to render. One request rather than two, because the landing page needs both
  // and a second round trip buys nothing.
  if (!segments.length && method === 'GET') {
    // Refreshed here rather than trusted from boot: this is the request that is
    // about to draw the menu, and somebody may have changed it in the panel
    // since the process started. One query.
    await refreshModelMenu();
    /*
     * THE SEVEN FIELDS THE CLIENT DECLARES, not the twenty the table has.
     *
     * `listAnalyses` is a bare `select()` and this route used to spread the row
     * straight out, so every request for the history list also shipped `owner`
     * and `context` — the free-text "anything the paper does not say" box the
     * submitter typed into — to anyone who asked for the landing page. The client
     * has never been able to read either: `AnalysisRow` declares what the page
     * renders and TypeScript would refuse anything else. So this is data leaving the box that
     * nothing wanted, which on a hostname with no authentication in front of it
     * is the whole of the exposure.
     */
    const analyses = (await listAnalyses(owner())).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      jurisdiction: row.jurisdiction,
      policyArea: row.policyArea,
    }));
    sendJson(res, 200, {
      analyses,
      models: commissionableModels(),
      stages: STAGES,
      readOnly: isReadOnly(),
    });
    return true;
  }

  // POST /api/policy-analysis — submit a paper
  if (!segments.length && method === 'POST') {
    // BEFORE `readSubmission`, which asks `isOfferedModel` whether the
    // commissioned model is real. An empty provider set here silently downgrades
    // the run to the configured default — and, for Codex, to the wrong deadline.
    await refreshModelMenu();
    const form = await readMultipart(req);
    /*
     * SHARED CONTEXT FIRST IS THE DEFAULT HERE, and it is a default this fork
     * chooses rather than one upstream ships.
     *
     * `ingest.ts` reads the flag as `=== 'true'`, so an absent field means off —
     * a sane default for a toggle nobody has measured, and the wrong one for a
     * deployment paying per token. It is the prompt-cache ordering: the pipeline
     * measured 66.1% of stage 3's input cached with it against 2.3% without, and
     * 65% less uncached input overall. The context-heavy stages carry up to
     * ~910,000 characters PER CALL; uncached, that is the whole bill.
     *
     * It cost a subscription on 2026-09-19. A run of 385 calls went out with the
     * flag unset because the caller had copied an older submission's fields, and
     * nothing on the way in asked whether that was deliberate.
     *
     * Set BEFORE `readSubmission` rather than by editing `ingest.ts`, which this
     * fork keeps byte-identical to upstream. A caller who genuinely wants the
     * old behaviour still gets it by sending the field as 'false'.
     */
    if (form.fields.sharedContextFirst === undefined) form.fields.sharedContextFirst = 'true';
    const submission = await readSubmission(asRequest(form.fields, form.file));
    const { createAnalysis } = await import('$lib/policy-analysis/server/store');
    const analysis = await createAnalysis(owner(), submission);
    onStarted(analysis.id);
    sendJson(res, 201, { id: analysis.id });
    return true;
  }

  // The persona library. Before the /:id routes, or "personas" is read as an id.
  if (segments[0] === 'personas') {
    const { listPersonas, personaDetail, removePersona } = await import('$lib/policy-analysis/server/personas');
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { personas: await listPersonas(owner()), readOnly: isReadOnly() });
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      const dossier = await personaDetail(owner(), segments[1]);
      if (!dossier) throw new HttpError(404, 'No such persona.');
      // `readOnly` rides along so the page can decline to draw a control that
      // would only 403, the same as the assessment detail.
      sendJson(res, 200, { ...dossier, readOnly: isReadOnly() });
      return true;
    }

    /*
     * POST /api/policy-analysis/personas/:id/research — enrich from public
     * sources, on the reader's explicit instruction.
     *
     * A ROUTE `researchPersona` HAS NEVER HAD. It sat in the copied store with
     * nothing calling it, which is the same shape of defect as `resolveShare`
     * one phase ago: a capability that is tested, reachable from nowhere, and
     * therefore never actually exercised.
     *
     * IT SPENDS MONEY — two model calls plus retrieval — so it is a POST, it is
     * refused outright in a read-only copy by the gate above, and it is rate
     * limited. Deliberately NOT part of a run: researching every actor of every
     * assessment would spend on bodies nobody asked about. This is a decision
     * made against a body the reader cares about.
     *
     * The request's own abort signal is passed through, so a reader who closes
     * the tab stops the work rather than paying for an answer nobody reads.
     */
    if (segments.length === 3 && segments[2] === 'research' && method === 'POST') {
      const { personaDetail, researchPersona } = await import('$lib/policy-analysis/server/personas');

      // VALIDATED BEFORE A TOKEN IS TAKEN. Six requests for an id that does not
      // exist cost nothing and used to lock the reader out of six that would.
      const dossier = await personaDetail(owner(), segments[1]);
      if (!dossier) throw new HttpError(404, 'No such persona.');

      /*
       * FAIL CLOSED WHERE THE DOCUMENT GUARD CANNOT WORK.
       *
       * `researchPersona` will not let a query quote the papers this dossier was
       * built from — it builds a shingle corpus of their passages and refuses
       * anything that matches. Two holes make that guard silent rather than
       * strict, and both are upstream:
       *
       *   A SEALED assessment stores its artefacts encrypted, and the corpus is
       *   read without unsealing. The shingles are then ciphertext, the dossier
       *   wording is plaintext, and nothing can ever match.
       *
       *   A PURGED assessment leaves no passages at all — its observation rows
       *   cascade away — while the wording it contributed survives in the
       *   persona's own dossier, which is not sealed and is not purged with it.
       *
       * Either way the reader would be sending a model the wording of a paper
       * whose confidentiality this service promised to keep. So the enquiry is
       * refused rather than run with a guard that cannot fire. Worth reporting
       * upstream, like the two in `share.ts`.
       */
      const contributing = [...new Set(dossier.observations.map((o) => o.analysisId).filter((a): a is string => !!a))];
      const present = new Set(dossier.analyses.map((a) => a.id));
      const missing = contributing.filter((id) => !present.has(id));
      // `personaDetail` does not select `sealed`, and it is a copied file. A
      // handful of owned lookups is the cheap way to ask.
      const rows = await Promise.all(contributing.filter((id) => present.has(id)).map((id) => ownedAnalysis(owner(), id)));
      const sealed = rows.filter((row) => row?.sealed);
      if (missing.length || sealed.length) {
        throw new HttpError(
          409,
          sealed.length
            ? 'This body was profiled from a sealed assessment, so an enquiry about it cannot be checked against the paper it came from. Sealed papers stay sealed.'
            : 'This body was profiled from an assessment that has since been purged, so an enquiry about it cannot be checked against the paper it came from.',
        );
      }

      /*
       * A BRAKE, NOT A QUOTA, and the difference is worth stating because the
       * first version of this comment got it wrong. The bucket holds four and
       * refills one every five minutes — but `rate-limit.ts` forgets a bucket
       * left untouched for ten, so anyone who waits gets a full four again. It
       * stops a stuck loop, which is what it is for; it does not cap a
       * determined reader, and nothing here pretends otherwise.
       */
      const limit = rateLimit(`persona-research:${owner()}`, { capacity: 4, refillPerSecond: 1 / 300 });
      if (!limit.allowed) {
        throw new HttpError(429, `Four enquiries in a row is enough at once. Another in ${Math.ceil(limit.retryAfterMs / 60000)} minutes.`);
      }

      /*
       * ONE AT A TIME PER OWNER. `researchPersona` reads the dossier, spends a
       * minute on two model calls, then writes `foldTraits(dossier, observed)`.
       * Two of those in flight both fold against the snapshot they opened with,
       * and the second silently overwrites the first — `applyPersonaLinks` takes
       * an advisory lock for exactly this reason and this path takes none.
       */
      const result = await queueResearch(owner(), async () => {
        const controller = new AbortController();
        // `close` rather than the `aborted` event, which has been deprecated
        // since Node 17: a cancellation that stops firing is a silent guard
        // death, and this one is what stops the spend.
        res.on('close', () => { if (!res.writableFinished) controller.abort(); });
        return researchPersona(owner(), segments[1], controller.signal);
      });
      sendJson(res, 200, result);
      return true;
    }
    if (segments.length === 2 && method === 'DELETE') {
      if (!(await removePersona(owner(), segments[1]))) throw new HttpError(404, 'No such persona.');
      sendJson(res, 200, { removed: true });
      return true;
    }
    return false;
  }

  const id = segments[0];
  if (!id) return false;

  // GET /api/policy-analysis/:id — everything the report page draws
  if (segments.length === 1 && method === 'GET') {
    const result = await detail(owner(), id);
    if (!result) throw new HttpError(404, 'No such assessment.');
    // `detail()` already carries the artefacts, unsealed. Loading them again
    // was a second query whose only effect was to overwrite its own field.
    // `readOnly` rides along so the page can decline to draw a control that
    // would only 403 — the same argument the landing page already makes. It is
    // read from the server rather than guessed, because the flag can change
    // under a running browser.
    const view = url.searchParams.get('view');
    const shaped = view === 'report' ? forTheReport(result)
      : view === 'progress' ? forProgress(result)
      : result;
    const body = { ...shaped, readOnly: isReadOnly() };

    /*
     * AN ASSESSMENT THAT HAS STOPPED CHANGING CAN BE REVALIDATED.
     *
     * Measured on the live service: opening the report, following one artefact
     * into the drill and pressing Back is three full fetches of the same
     * assessment — 13,469,643 decoded bytes — because React Router remounts each
     * route and `sendJson` sets nothing but content-type and content-length, so
     * the browser has no way to ask "still the same?".
     *
     * `updatedAt` moves on every mutation, which makes it the version. `readOnly`
     * is folded in because it is sent from here precisely because it can change
     * under a running browser, and an ETag keyed on the row alone would serve a
     * stale one from the cache. `private` because this is one reader's own work
     * and no shared cache should hold it.
     */
    const stamp = result.analysis.updatedAt;
    const version = stamp instanceof Date ? stamp.toISOString() : String(stamp ?? '');
    const etag = `W/"${id}-${version}-${isReadOnly() ? 'ro' : 'rw'}-${view ?? 'full'}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'private, must-revalidate' }).end();
      return true;
    }
    sendJson(res, 200, body, { etag, 'cache-control': 'private, must-revalidate' });
    return true;
  }

  /*
   * GET /api/policy-analysis/:id/progress — how far, and how much longer.
   *
   * Its own route because the page POLLS it. The detail endpoint carries every
   * artefact of the run, which on a real assessment is thousands of rows to
   * render one sentence about the clock; this is a dozen numbers.
   *
   * The SSE stream beside it fires when a STAGE ends, and a stage can take forty
   * minutes — so between those events the page had nothing to say and no way to
   * say how long was left. This is what fills that silence.
   */
  if (segments.length === 2 && segments[1] === 'progress' && method === 'GET') {
    const progress = await runProgress(owner(), id);
    if (!progress) throw new HttpError(404, 'No such assessment.');
    sendJson(res, 200, progress);
    return true;
  }

  // DELETE /api/policy-analysis/:id — purge, and hand back the receipt
  if (segments.length === 1 && method === 'DELETE') {
    const result = await purge(owner(), id);
    if (!result) throw new HttpError(404, 'No such assessment.');
    sendJson(res, 200, {
      receipt: buildReceipt({
        analysisId: result.id,
        sealed: result.sealed,
        keyDestroyed: result.keyDestroyed,
        probes: await census(id),
        keyLocation: keyDir(),
      }),
    });
    return true;
  }

  if (segments.length === 2 && method === 'POST') {
    const action = segments[1];
    if (!(await ownedAnalysis(owner(), id))) throw new HttpError(404, 'No such assessment.');

    if (action === 'cancel' || action === 'resume') {
      await control(owner(), id, action);
      if (action === 'resume') onStarted(id);
      sendJson(res, 200, { status: await analysisStatus(id) });
      return true;
    }
    if (action === 'restate') {
      await restate(owner(), id);
      onStarted(id);
      sendJson(res, 200, { status: await analysisStatus(id) });
      return true;
    }
    if (action === 'material') {
      const form = await readMultipart(req);
      await addMaterial(owner(), id, await readMaterial(asRequest(form.fields, form.file)));
      onStarted(id);
      sendJson(res, 200, { status: await analysisStatus(id) });
      return true;
    }
    return false;
  }

  // GET /api/policy-analysis/:id/export?format=docx|md|bundle
  //
  // A GET rather than a POST because it is a download of something that already
  // exists: it changes nothing, so the browser's own save dialog does the rest
  // and the link can be right-clicked like any other.
  if (segments.length === 2 && segments[1] === 'export' && method === 'GET') {
    const format = url.searchParams.get('format') ?? 'docx';
    if (!isDownloadFormat(format)) throw new HttpError(400, 'Ask for docx, md or bundle.');
    /*
     * `scope=shared` IS HOW A REDACTED COPY LEAVES THIS SERVICE, and it leaves
     * as a FILE.
     *
     * There was a token route here that handed a redacted copy to whoever held
     * a URL. It was removed, because on this architecture the promise it made
     * was false: every owner route is unauthenticated by design — the server
     * binds to loopback and everything it serves belongs to whoever reaches the
     * port — so a recipient who could use the link could also call
     * `GET /api/policy-analysis/:id` and read the whole paper two requests
     * later. Advertising a redaction the deployment does not enforce is worse
     * than not offering one.
     *
     * A file has no such hole. It carries exactly what `shareableReport` left
     * in it, needs no server, cannot be walked sideways, does not expire, has
     * nothing to revoke, and still works behind a Cloudflare Access policy that
     * would refuse a recipient outright. See docs/phase-10.md.
     */
    const shared = url.searchParams.get('scope') === 'shared';
    const result = await detail(owner(), id);
    if (!result) throw new HttpError(404, 'No such assessment.');

    const meta = {
      title: result.analysis.title,
      jurisdiction: result.analysis.jurisdiction,
      policyArea: result.analysis.policyArea,
      status: result.analysis.status,
      completedAt: result.analysis.completedAt,
    };

    // ONE REDACTOR, and the documents and the pack are rendered from its output
    // rather than each filtering for themselves.
    const redacted = shared ? shareableReport({ artefacts: result.artefacts, stages: result.stages }) : null;
    const artefacts = redacted ? redacted.artefacts : result.artefacts;

    /*
     * WHAT THE RUN DID TRAVELS WITH IT. Without this the pack's page had no
     * stage statuses and no model to print, so it invented them — "256 of 256
     * completed" for a run that failed at 17 of 18. See `$lib/offline-run`.
     */
    const pack: PackPayload = {
      ...(redacted
        ? sharedPayload({ ...meta, artefacts, warnings: redacted.warnings, withheld: redacted.withheld })
        : ownerPayload({
            ...meta,
            sealed: result.analysis.sealed,
            documentSha256: result.documents?.[0]?.sha256 ?? null,
            artefacts,
            stages: result.stages,
          })),
      run: runFacts(result),
    };

    const response = isExportFormat(format)
      ? await assessmentDocument(artefacts, meta, format)
      : await assessmentBundle({ payload: pack, meta });

    await pipeResponse(response, res);
    return true;
  }

  return false;
}
