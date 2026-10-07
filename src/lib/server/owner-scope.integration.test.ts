/**
 * EACH READER SEES ONLY THEIR OWN PAPERS, when `POLICY_OWNER_SCOPE=user`.
 *
 * A real server around the real API, two signed-in readers as the Databricks
 * Apps proxy would present them, and every way one could reach the other's
 * paper: the list, the detail, the progress, the event stream, the control
 * actions and the purge. Before this, every reader on an App was one owner.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

vi.mock('$lib/policy-analysis/server/research', () => ({
  research: async () => ({ artefacts: [], warnings: ['Synthetic test: external research unavailable.'] }),
}));

const { handleApi, toHttpError } = await import('../../../server/api');
const { requestOwner } = await import('../../../server/owner');
const { ownedAnalysis } = await import('$lib/policy-analysis/server/store');
const { sendJson } = await import('../../../server/http');

const local =
  process.env.POLICY_LOCAL_TESTS === '1' &&
  /policy-test-[^/]+\/db$/.test(process.env.POLICY_DATA_DIR ?? '');

const ALICE = 'alice@example.org';
const BOB = 'bob@example.org';
let server: Server;
let base = '';

// The two routes the scope touches, wired as `server/index.ts` wires them.
function start(): Promise<void> {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.endsWith('/events')) {
        const id = url.pathname.split('/').at(-2)!;
        if (!(await ownedAnalysis(requestOwner(req), id))) return sendJson(res, 404, { message: 'No such assessment.' });
        return sendJson(res, 200, { open: id });
      }
      if (!(await handleApi(req, res, url, () => {}))) sendJson(res, 404, { message: 'Not found' });
    } catch (err) {
      const e = toHttpError(err);
      sendJson(res, e.status, { message: e.message });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/policy-analysis`;
    resolve();
  }));
}

const as = (email: string | null, path = '', init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'sec-fetch-site': 'same-origin', ...(email ? { 'x-forwarded-email': email } : {}), ...(init.headers ?? {}) },
  });

async function submit(email: string, title: string): Promise<string> {
  const form = new FormData();
  form.set('title', title);
  form.set('depth', 'standard');
  form.set('document', new Blob([readFileSync('tests/fixtures/policy-analysis/policy.txt')], { type: 'text/plain' }), 'policy.txt');
  const res = await as(email, '', { method: 'POST', body: form });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

describe.skipIf(!local)('each reader sees only their own papers', () => {
  let alices = '';
  let bobs = '';

  beforeAll(async () => {
    process.env.POLICY_OWNER_SCOPE = 'user';
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    await start();
    alices = await submit(ALICE, 'Alice’s paper');
    bobs = await submit(BOB, 'Bob’s paper');
  });

  afterAll(async () => {
    delete process.env.POLICY_OWNER_SCOPE;
    delete process.env.DATABRICKS_APP_NAME;
    await new Promise((resolve) => server.close(resolve));
  });

  it('lists only the reader’s own', async () => {
    const list = (await (await as(ALICE)).json()) as { analyses: { id: string }[] };
    expect(list.analyses.map((a) => a.id)).toContain(alices);
    expect(list.analyses.map((a) => a.id)).not.toContain(bobs);
  });

  it('will not open, follow, stream, control or purge someone else’s', async () => {
    expect((await as(ALICE, `/${bobs}`)).status).toBe(404);
    expect((await as(ALICE, `/${bobs}/progress`)).status).toBe(404);
    expect((await as(ALICE, `/${bobs}/events`)).status).toBe(404);
    expect((await as(ALICE, `/${bobs}/cancel`, { method: 'POST' })).status).toBe(404);
    expect((await as(ALICE, `/${bobs}`, { method: 'DELETE' })).status).toBe(404);
    // Bob's is untouched, and still his.
    expect((await as(BOB, `/${bobs}`)).status).toBe(200);
    expect((await as(BOB, `/${bobs}/events`)).status).toBe(200);
  });

  it('treats the same person the same whatever the case of their address', async () => {
    expect((await as('ALICE@Example.org', `/${alices}`)).status).toBe(200);
  });

  it('refuses a request with no signed-in reader, rather than falling back to a shared owner', async () => {
    expect((await as(null)).status).toBe(401);
    expect((await as(null, `/${alices}`)).status).toBe(401);
  });
});
