#!/usr/bin/env node
/**
 * THE DEFAULT CREDENTIAL CANNOT SURVIVE, AND THE GATES ACTUALLY GATE.
 *
 *   npm run claim
 *
 * This service ships accepting `admin` / `admin`. That is what the owner asked
 * for and it is the shape of failure this repository's own `CLAUDE.md` records
 * from a 33-hour outage — so the fencing around it is not something to leave to
 * a code review. Every claim made in `src/lib/server/claim.ts` is exercised
 * here against a real server over real HTTP.
 *
 * IT IS NOT A BROWSER TEST. `npm run walk` drives the forms; this drives the
 * rules underneath them, because the rules are what an attacker talks to. No
 * page is ever loaded, which is also why it takes seconds rather than minutes.
 *
 * FOUR SERVERS, each on its own throwaway database, because the questions are
 * about what a FRESH install does and an install can only be fresh once.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];
const note = (m) => console.log(`  ${m}`);
const check = (ok, message) => { if (!ok) failures.push(message); };

let port = 5310;

/**
 * A fixture server on its own database, with whatever environment the case
 * needs.
 *
 * The FIXTURE build, so nothing here can reach a provider however it is
 * configured — the same guarantee the walk relies on, and the reason this can
 * safely accept an API key without one existing.
 */
async function startServer(env) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'policy-claim-'));
  const PORT = port++;
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server-fixture.js')], {
    env: {
      ...process.env,
      POLICY_PORT: String(PORT),
      // Never Lakebase, whatever the shell says.
      POLICY_DATABASE: '',
      POLICY_DATA_DIR: path.join(dataRoot, 'db'),
      POLICY_SEAL_KEY_DIR: path.join(dataRoot, 'keys'),
      // Whatever the case is about. Deleted rather than inherited, so a variable
      // set in the developer's shell cannot quietly make a case pass.
      POLICY_ADMIN_PASSWORD: '',
      POLICY_SETUP_TOKEN: '',
      POLICY_ACCESS: '',
      POLICY_READER_PASSWORD: '',
      POLICY_HOST: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const text = String(d);
    if (!/WARNING|warn/i.test(text)) process.stderr.write(`  server: ${text}`);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Policy Red Team on')) { clearTimeout(timer); resolve(); }
    });
  });
  // The host it BOUND to may not be the one a request goes to: the off-loopback
  // cases configure `POLICY_HOST` to exercise the rule, and 127.0.0.2 is still
  // reachable here.
  const base = `http://${(env.POLICY_HOST || '127.0.0.1')}:${PORT}`;
  return {
    base,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      child.kill('SIGKILL');
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

/** One request, returning status, body and any cookie it set. */
async function call(base, url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      // A same-origin browser request, because the cross-site guard is one of
      // the things under test and everything else must not trip it.
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, text, cookie: setCookie ? setCookie.split(';')[0] : null };
}

const NEW_PASSWORD = 'a-long-enough-new-password';

// ── 1. A fresh install on loopback ──────────────────────────────────────────
{
  const server = await startServer({});
  try {
    const status = await call(server.base, '/api/admin/status');
    check(status.json?.claimable === true, `fresh install does not offer to be claimed: ${status.text}`);
    check(status.json?.signedIn === false, 'a fresh install reports somebody signed in');

    // THE SHIPPED CREDENTIAL IS NOT A LOGIN. It is accepted on exactly one
    // route, and that route's only effect is to replace it.
    const asLogin = await call(server.base, '/api/admin/session', { method: 'POST', body: { password: 'admin' } });
    check(asLogin.status === 401, `admin/admin signed in through the ordinary session route (${asLogin.status})`);
    check(!asLogin.cookie, 'the session route issued a cookie for the shipped password');

    const short = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: 'short' },
    });
    check(short.status === 400, `a too-short new password was accepted (${short.status})`);
    check(!short.cookie, 'a refused claim still issued a cookie');

    const asDefault = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: 'admin' },
    });
    check(asDefault.status === 400, 'the shipped password was accepted as the NEW password');

    const wrong = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'not-admin', newPassword: NEW_PASSWORD },
    });
    check(wrong.status === 401, `a claim with the wrong current password succeeded (${wrong.status})`);

    const claimed = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: NEW_PASSWORD },
    });
    check(claimed.status === 200, `the claim failed: ${claimed.text}`);
    check(Boolean(claimed.cookie), 'a successful claim issued no session');
    note('a fresh install is claimed once, and only by replacing the shipped password');

    // ── The default is gone, and every door it used is shut ────────────────
    const after = await call(server.base, '/api/admin/status');
    check(after.json?.claimable === false, 'the install still offers to be claimed after being claimed');

    const again = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: 'another-long-password' },
    });
    check(again.status === 403, `the install could be claimed a second time (${again.status})`);

    const defaultLogin = await call(server.base, '/api/admin/session', { method: 'POST', body: { password: 'admin' } });
    check(defaultLogin.status === 401, 'admin/admin still signs in after the password was changed');
    note('THE SHIPPED PASSWORD NO LONGER WORKS, by any route');

    const signedIn = await call(server.base, '/api/admin/session', { method: 'POST', body: { password: NEW_PASSWORD } });
    check(signedIn.status === 200, `the new password does not sign in: ${signedIn.text}`);
    const cookie = signedIn.cookie;

    const config = await call(server.base, '/api/admin/config', { cookie });
    check(config.status === 200, `a signed-in session cannot read the config (${config.status})`);

    // ── Changing it again ends every other session ─────────────────────────
    const changed = await call(server.base, '/api/admin/password', {
      method: 'POST', cookie, body: { current: NEW_PASSWORD, next: 'a-third-long-password' },
    });
    check(changed.status === 200, `the password could not be changed: ${changed.text}`);
    const withOld = await call(server.base, '/api/admin/config', { cookie });
    check(withOld.status === 401, 'a session issued under the old password still works');
    note('changing the password ends every session, including the one that changed it');

    // ── No secret ever comes back out ──────────────────────────────────────
    const fresh = await call(server.base, '/api/admin/session', { method: 'POST', body: { password: 'a-third-long-password' } });
    await call(server.base, '/api/admin/config/openrouter', {
      method: 'POST', cookie: fresh.cookie, body: { values: { apiKey: 'sk-or-claim-check-secret' } },
    });
    const readBack = await call(server.base, '/api/admin/config', { cookie: fresh.cookie });
    check(!readBack.text.includes('sk-or-claim-check-secret'), 'a saved key comes back out of the config endpoint');
    check(!readBack.text.includes('a-third-long-password'), 'the admin password appears in the config endpoint');
    check(!readBack.text.includes('scrypt$'), 'the password VERIFIER appears in the config endpoint');
    note('no secret, password or verifier comes back out');
  } finally {
    await server.stop();
  }
}

// ── 2. A fresh install that is NOT on loopback, with no token ───────────────
{
  /*
   * `POLICY_HOST` is what the operator configured this process to bind to, and
   * that is what the rule reads — never where a request claims to come from,
   * which behind a tunnel is always 127.0.0.1 and tells you nothing.
   *
   * 127.0.0.2 is used because it is outside the loopback names the rule accepts
   * while still being reachable from this machine. The rule being exercised is
   * about the CONFIGURED host, not about the network, so this is the honest
   * way to drive it without opening a port on the LAN.
   */
  const server = await startServer({ POLICY_HOST: '127.0.0.2' });
  try {
    const status = await call(server.base, '/api/admin/status');
    // UNCLAIMED AND CLOSED MUST LOOK THE SAME to an unauthenticated caller.
    // Publishing "this install has not been set up" to anything that can reach
    // it turns a time-boxed window into a discoverable one.
    check(status.json?.claimable === false, 'an off-loopback install advertises that it can be claimed');

    const claimed = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: NEW_PASSWORD },
    });
    check(claimed.status === 403, `an off-loopback install was claimed with no setup token (${claimed.status})`);
    check(!claimed.cookie, 'a refused off-loopback claim still issued a cookie');
    note('off loopback with no setup token, the shipped credential is refused and not advertised');
  } finally {
    await server.stop();
  }
}

// ── 3. Off loopback WITH a setup token ──────────────────────────────────────
{
  const server = await startServer({ POLICY_HOST: '127.0.0.2', POLICY_SETUP_TOKEN: 'the-operators-token' });
  try {
    const status = await call(server.base, '/api/admin/status');
    check(status.json?.tokenRequired === true, 'the install does not say a setup token is needed');

    const noToken = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: NEW_PASSWORD },
    });
    check(noToken.status === 401, `a claim without the token succeeded (${noToken.status})`);

    const wrongToken = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: NEW_PASSWORD, setupToken: 'wrong' },
    });
    check(wrongToken.status === 401, `a claim with the wrong token succeeded (${wrongToken.status})`);

    const ok = await call(server.base, '/api/admin/claim', {
      method: 'POST', body: { username: 'admin', password: 'admin', newPassword: NEW_PASSWORD, setupToken: 'the-operators-token' },
    });
    check(ok.status === 200, `a claim with the right token failed: ${ok.text}`);
    note('off loopback WITH the token, the claim works and nothing else does');
  } finally {
    await server.stop();
  }
}

// ── 4. The reader gate, and the cross-site guard ────────────────────────────
{
  const server = await startServer({
    POLICY_ADMIN_PASSWORD: 'a-long-enough-admin-password',
    POLICY_ACCESS: 'password',
    POLICY_READER_PASSWORD: 'a-long-enough-reader-password',
  });
  try {
    const closed = await call(server.base, '/api/policy-analysis');
    check(closed.status === 401, `the reader gate is on and the API answered ${closed.status}`);

    /*
     * THE SHELL IS NOT GATED, deliberately: the page that draws the sign-in
     * form has to load before anybody can sign in.
     *
     * A 404 HERE IS A DIFFERENT FAULT and has to say so. It means `dist/client`
     * was never built, not that the gate is too wide — and the first time this
     * ran in a clean clone it reported an unbuilt client as a security finding,
     * which is the kind of misdirection that costs an hour.
     */
    const shell = await fetch(`${server.base}/`, { headers: { 'sec-fetch-site': 'same-origin' } });
    if (shell.status === 404) {
      check(false, 'the client is not built — run `npm run build`, not `node build.mjs`, before this check');
    } else {
      check(shell.status === 200, `the client shell is gated too, so nobody could ever sign in (${shell.status})`);
    }

    // AND `/health` IS EXEMPT, because the deploy script's smoke test is exactly
    // this and a gate that fails the deploy installing it is a gate nobody keeps.
    const health = await call(server.base, '/health');
    check(health.status === 200, `/health is gated (${health.status})`);
    check(!health.text.includes('running'), '/health still lists the assessments in flight');

    const wrong = await call(server.base, '/api/reader/session', { method: 'POST', body: { password: 'nope' } });
    check(wrong.status === 401, 'a wrong reader password signed in');

    const reader = await call(server.base, '/api/reader/session', {
      method: 'POST', body: { password: 'a-long-enough-reader-password' },
    });
    check(reader.status === 200, `the reader password does not sign in: ${reader.text}`);
    check(reader.cookie?.startsWith('policy_reader='), `the reader cookie is not its own: ${reader.cookie}`);

    const open = await call(server.base, '/api/policy-analysis', { cookie: reader.cookie });
    check(open.status === 200, `a signed-in reader still cannot read (${open.status})`);

    // A READER PASSWORD IS NOT AN ADMIN PASSWORD. This is the whole reason
    // there are two of them.
    const asAdmin = await call(server.base, '/api/admin/session', {
      method: 'POST', body: { password: 'a-long-enough-reader-password' },
    });
    check(asAdmin.status === 401, 'the READER password opens the credential editor');

    const adminSession = await call(server.base, '/api/admin/session', {
      method: 'POST', body: { password: 'a-long-enough-admin-password' },
    });
    const adminReads = await call(server.base, '/api/policy-analysis', { cookie: adminSession.cookie });
    check(adminReads.status === 200, 'an admin session does not open the reader side');
    note('two gates, two passwords, and an admin session opens both');

    // ── The cross-site guard ───────────────────────────────────────────────
    const crossSite = await call(server.base, '/api/reader/session', {
      method: 'POST', body: { password: 'a-long-enough-reader-password' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    check(crossSite.status === 403, `a cross-site POST was accepted (${crossSite.status})`);

    const evilOrigin = await fetch(`${server.base}/api/policy-analysis`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    check(evilOrigin.status === 403, `a POST from another origin was accepted (${evilOrigin.status})`);

    // A GET from anywhere is still fine: its response is unreadable to the
    // other page, and refusing those would break an ordinary link.
    const crossSiteGet = await call(server.base, '/health', { headers: { 'sec-fetch-site': 'cross-site' } });
    check(crossSiteGet.status === 200, 'a cross-site GET was refused, which breaks ordinary links');
    note('another website cannot make this service do anything');
  } finally {
    await server.stop();
  }
}

if (failures.length) {
  console.error('\nFAILED');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nPASSED — the shipped credential cannot survive, and both gates gate');
