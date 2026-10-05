/**
 * THE ADMIN API — the only part of this service behind a password.
 *
 * Everything here changes what the install does or holds a credential, so the
 * whole branch is gated before any handler runs. The gate is a signed cookie
 * (`$lib/server/admin-auth`), NOT an address check: behind a tunnel every
 * request arrives from 127.0.0.1, so "local connections only" is a gate that
 * passes for the entire internet — the mistake that took the author's main site
 * down for 33 hours.
 *
 * A SECRET GOES IN AND DOES NOT COME OUT. `GET /api/admin/config` reports
 * whether each secret is set, never its value, so a screenshot, a proxy log or a
 * browser cache between here and the reader carries nothing worth having. The
 * same posture the share token had, for the same reason.
 *
 * SIGNING IN IS RATE LIMITED. A password reachable from the open internet with
 * unlimited attempts is a password with a deadline, and the limiter this repo
 * already has is a token bucket per source — which behind a tunnel is one
 * bucket for everyone, and that is the conservative direction.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ADMIN_COOKIE, clearedCookie, issueSession, passwordMatches,
  readCookie, sessionCookie, sessionValid, type Credential,
} from '$lib/server/admin-auth';
import { adminCredential, adminPasswordIsPinned, setAdminPassword, setReaderPassword, readerPasswordIsPinned } from '$lib/server/credential-store';
import { claimState, setupTokenAccepted } from '$lib/server/claim';
import { isDefaultCredential, passwordProblem } from '$lib/server/credentials';
import { accessMode, accessModeIsPinned, accessSummary, setAccessMode, type AccessMode } from '$lib/server/reader-access';
import { chosenEngine, saveSearchConfig, searchDomains, searchIsPinned, searchPlan, tavilyKey, type SearchEngine } from '$lib/server/search';
import { rateLimit } from '$lib/server/rate-limit';
import { adminGroup, isGroupAdmin, workspaceUser } from '$lib/server/workspace-admin';
import { providers, redact, type ProviderConfig } from '$lib/llm/providers';
import { clearLLMClientCache, resolveProvider } from '$lib/llm/client';
import { builtInModels, offeredModels, registerProviderModels, tierForCost, type OfferedModel } from '$lib/server/models/catalogue';
import { loadOfferedModels, saveOfferedModels, refreshModelMenu, RUN_TOKEN_CEILING } from '$lib/server/models/offered-store';
import { tokenCeiling } from '$lib/server/budget';
import {
  ACTIVE_PROVIDER, deleteSetting, providerSettingKey, readAll, writeSetting,
} from '$lib/server/settings-store';
import { HttpError, readJson, sendJson } from './http';

/**
 * WHAT LAST ANSWERED, AND WHEN — the one piece of setup state that is recorded
 * rather than derived.
 *
 * Everything else the task list shows is computed from what the install holds,
 * because a stored "done" outlives the thing it was about. This cannot be: the
 * question "does this credential actually reach a model" has no answer except
 * making a call. So it is written when a call succeeds and deleted wherever the
 * configuration beneath it changes.
 */
const LAST_PROBE = 'setup.lastProbe';

/** True when the reader reached us over HTTPS — behind a tunnel, only the header knows. */
function isSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? '').split(',')[0].trim() === 'https';
}

export async function isSignedIn(req: IncomingMessage): Promise<boolean> {
  // A named admin group replaces the password outright: no cookie, no form.
  if (adminGroup()) return isGroupAdmin(req);
  return sessionValid(readCookie(req.headers.cookie, ADMIN_COOKIE), await adminCredential());
}

/**
 * Whether the panel exists at all on this install, and what to say if not.
 *
 * Reported without a session on purpose: the sign-in page needs to be able to
 * say "no password is set here" rather than presenting a form that cannot
 * succeed. It reveals nothing — an install with no admin password has no
 * credentials to protect through this route.
 */
export async function adminStatus(req: IncomingMessage) {
  const group = adminGroup();
  if (group) {
    const signedIn = await isGroupAdmin(req);
    return {
      available: signedIn,
      problem: signedIn ? null : `Only members of the ${group} group can open this page.${workspaceUser(req) ? '' : ' Your sign-in did not reach the app.'}`,
      signedIn,
      claimable: false,
      tokenRequired: false,
      group,
    };
  }
  const credential = await adminCredential();
  const signedIn = sessionValid(readCookie(req.headers.cookie, ADMIN_COOKIE), credential);
  if (credential) return { available: true, problem: null, signedIn, claimable: false, tokenRequired: false };

  /*
   * NO CREDENTIAL. Whether that means "claimable" or "closed" is the one thing
   * this endpoint must be careful about, because it answers WITHOUT a session.
   *
   * An unclaimed install says so only when the claim would actually be
   * accepted — on loopback, or where a setup token is configured. Anywhere else
   * an unclaimed install and a closed one are reported identically, so that
   * scanning the internet for this service does not produce a list of installs
   * waiting to be taken with a credential printed in the README.
   */
  const claim = await claimState();
  if (claim.claimable || claim.tokenRequired) {
    return {
      available: true,
      problem: null,
      signedIn: false,
      claimable: claim.claimable,
      // True means "and you will need the setup token", which is not a secret:
      // it is a fact about the deployment that the person holding the token
      // needs, and it reveals nothing to anyone who does not hold it.
      tokenRequired: claim.tokenRequired,
    };
  }
  return {
    available: false,
    problem:
      'This install has no admin password and cannot be set up from the browser. ' +
      'Set POLICY_ADMIN_PASSWORD on the server and restart.',
    signedIn: false,
    claimable: false,
    tokenRequired: false,
  };
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
): Promise<boolean> {
  // ── Unauthenticated: only what the sign-in page itself needs ──────────────
  if (segments.length === 1 && segments[0] === 'status' && method === 'GET') {
    sendJson(res, 200, await adminStatus(req));
    return true;
  }

  /*
   * THE CLAIM. The one request the shipped `admin`/`admin` is accepted on, and
   * the only thing it can do is replace itself.
   *
   * NO COOKIE IS ISSUED BEFORE THE NEW PASSWORD IS WRITTEN. A bootstrap session
   * carrying a "you must change this" flag was considered and rejected: while
   * unclaimed there is no verifier, so such a cookie could only be signed with a
   * key derived from a credential that is printed in the README. A session token
   * minted under a guessable credential is the thing this whole file exists to
   * prevent.
   */
  if (adminGroup() && ['claim', 'session', 'password'].includes(segments[0] ?? '') && method === 'POST') {
    throw new HttpError(409, `This app's admins are the members of the ${adminGroup()} group. There is no password to use.`);
  }

  if (segments.length === 1 && segments[0] === 'claim' && method === 'POST') {
    const limit = rateLimit('admin-claim', { capacity: 5, refillPerSecond: 1 / 60 });
    if (!limit.allowed) {
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(limit.retryAfterMs / 1000)} seconds.`);
    }
    const claim = await claimState();
    if (!claim.claimable) {
      // The reason is written to the server's log, where an operator can read
      // it, and not to the caller — "this install holds assessments" tells a
      // stranger something true about a service they have no business knowing.
      console.warn(`admin: a claim was refused — ${claim.reason}`);
      throw new HttpError(403, 'This install cannot be set up from the browser.');
    }

    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const token = typeof body.setupToken === 'string' ? body.setupToken : undefined;
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!setupTokenAccepted(token)) throw new HttpError(401, 'That is not the setup token.');
    if (!isDefaultCredential(username, password)) throw new HttpError(401, 'That is not the sign-in this install ships with.');

    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(400, problem);

    await setAdminPassword(newPassword);
    const credential = await adminCredential();
    if (!credential) throw new HttpError(500, 'The password was not stored.');
    res.setHeader('set-cookie', sessionCookie(issueSession(credential), isSecure(req)));
    sendJson(res, 200, { signedIn: true });
    return true;
  }

  if (segments.length === 1 && segments[0] === 'session' && method === 'POST') {
    const credential = await adminCredential();
    // One bucket for everyone behind a tunnel, which is the conservative
    // direction: a shared limit slows an attacker and inconveniences one owner.
    const limit = rateLimit('admin-signin', { capacity: 8, refillPerSecond: 1 / 30 });
    if (!limit.allowed) {
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(limit.retryAfterMs / 1000)} seconds.`);
    }
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    // AN UNCLAIMED INSTALL ANSWERS THIS EXACTLY AS A WRONG PASSWORD DOES.
    // `passwordMatches` is false for a null credential, so no branch here
    // distinguishes "no password is set" from "that is not it" — the claim
    // route is where an unclaimed install is told so, and only when it is
    // entitled to be.
    if (!passwordMatches(password, credential)) {
      throw new HttpError(401, 'That is not the password.');
    }
    res.setHeader('set-cookie', sessionCookie(issueSession(credential!), isSecure(req)));
    sendJson(res, 200, { signedIn: true });
    return true;
  }

  if (segments.length === 1 && segments[0] === 'session' && method === 'DELETE') {
    res.setHeader('set-cookie', clearedCookie(isSecure(req)));
    sendJson(res, 200, { signedIn: false });
    return true;
  }

  // ── Everything below needs the cookie ─────────────────────────────────────
  if (!(await isSignedIn(req))) throw new HttpError(401, 'Sign in to the admin panel first.');

  /*
   * CHANGING THE ADMIN PASSWORD, from inside a session.
   *
   * The current password is required even though the caller already holds a
   * cookie: the cookie may be a borrowed laptop, and a password change is the
   * one action that locks its real owner out.
   */
  if (segments.length === 1 && segments[0] === 'password' && method === 'POST') {
    if (adminPasswordIsPinned()) {
      throw new HttpError(409, 'POLICY_ADMIN_PASSWORD is set on the server, which wins over anything saved here. Change it there.');
    }
    const body = await readJson(req);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    if (!passwordMatches(current, await adminCredential())) throw new HttpError(401, 'That is not the current password.');
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, problem);
    await setAdminPassword(next);
    // EVERY SESSION DIED, including this one — the cookie's signing key is
    // derived from the verifier. Re-issue for the caller who just proved they
    // know both passwords, and leave everyone else signed out.
    const credential = await adminCredential();
    res.setHeader('set-cookie', sessionCookie(issueSession(credential!), isSecure(req)));
    sendJson(res, 200, { changed: true });
    return true;
  }

  /*
   * WHERE RESEARCH GETS ITS SOURCES — a choice, not a degradation.
   *
   * An install that cannot reach the open web should be able to SAY so, once,
   * and have every run skip the asking. Before this it discovered the answer
   * once per question, at the cost of a model call each time, and reported it
   * as a gap rather than as the decision it was.
   */
  if (segments.length === 1 && segments[0] === 'search' && method === 'POST') {
    if (searchIsPinned()) {
      throw new HttpError(409, 'POLICY_SEARCH is set on the server, which wins over anything saved here.');
    }
    const body = await readJson(req);
    const engine = body.engine as SearchEngine | undefined;
    if (engine && !['auto', 'tavily', 'grounded', 'none'].includes(engine)) {
      throw new HttpError(400, 'Search is auto, tavily, grounded or none.');
    }
    await saveSearchConfig({
      engine,
      // A BLANK KEY IS "LEAVE IT ALONE", the same rule every other secret here
      // follows, because the box is always empty and treating blank as a
      // deletion would wipe it every time somebody edited the field beside it.
      ...(typeof body.tavilyKey === 'string' && body.tavilyKey.trim() ? { tavilyKey: body.tavilyKey } : {}),
      ...(typeof body.domains === 'string' ? { domains: body.domains } : {}),
    });
    sendJson(res, 200, await configPayload());
    return true;
  }

  /*
   * WHO MAY READ THE ASSESSMENTS. Separate from the admin password, and
   * separately stored: a reader who can open an assessment must not thereby
   * hold the key to the API keys.
   */
  if (segments.length === 1 && segments[0] === 'access' && method === 'POST') {
    const body = await readJson(req);
    const mode = body.mode as AccessMode;
    if (mode !== 'open' && mode !== 'password') throw new HttpError(400, 'Access is either open or password.');
    if (mode === 'password') {
      const reader = typeof body.readerPassword === 'string' ? body.readerPassword : '';
      if (reader) {
        const problem = passwordProblem(reader);
        if (problem) throw new HttpError(400, problem);
        await setReaderPassword(reader);
      } else if (!readerPasswordIsPinned()) {
        // Turning the gate on without a password behind it would lock everyone
        // out, including the person doing it.
        throw new HttpError(400, 'Set a reader password before turning the gate on.');
      }
    }
    await setAccessMode(mode);
    sendJson(res, 200, await configPayload());
    return true;
  }

  if (segments.length === 1 && segments[0] === 'config' && method === 'GET') {
    sendJson(res, 200, await configPayload());
    return true;
  }

  /*
   * WHAT IS LEFT TO SET UP, as a GOV.UK task list.
   *
   * Derived, never stored as a checklist. A stored "done" is a claim about the
   * past that survives the thing it was about — a provider configured and then
   * cleared would still read as complete. Every status below is computed from
   * what the install actually holds right now, so the only way to make a task
   * say "done" is for it to be done.
   *
   * ONE TASK IS DIFFERENT AND IT IS THE IMPORTANT ONE. "Try the connection" is
   * the only status this cannot derive, because the question it answers —
   * does this credential actually reach a model — has no answer except making
   * a call. So that one IS recorded, with what it reached and when, and it is
   * cleared whenever the configuration under it changes.
   */
  if (segments.length === 1 && segments[0] === 'setup' && method === 'GET') {
    sendJson(res, 200, await setupPayload());
    return true;
  }

  if (segments.length === 2 && segments[0] === 'config' && method === 'POST') {
    const definition = providers().find((p) => p.id === segments[1]);
    if (!definition) throw new HttpError(404, 'This build does not offer that provider.');
    const body = await readJson(req);
    const values = (body.values ?? {}) as Record<string, unknown>;

    for (const field of definition.fields) {
      const raw = values[field.name];
      if (raw === undefined) continue; // not sent: leave what is stored alone
      if (typeof raw !== 'string') throw new HttpError(400, `${field.label} has to be text.`);
      const value = raw.trim();
      // AN EMPTY SECRET CLEARS IT rather than storing a blank, so "remove this
      // key" is expressible. A non-secret empty value is a real value.
      if (!value && field.secret) await deleteSetting(providerSettingKey(definition.id, field.name));
      else await writeSetting(providerSettingKey(definition.id, field.name), value);
    }

    clearLLMClientCache();
    // A CHANGED CREDENTIAL HAS NOT BEEN TESTED. Leaving the last result in
    // place would let a working test vouch for a configuration that has since
    // been edited, which is the same class of lie as "saved means reachable".
    await deleteSetting(LAST_PROBE);
    // The MODEL is one of these fields, and a provider that pins one decides the
    // per-call deadline for every run that commissions nothing. Leaving the
    // registry stale here means the panel says one model and an uncommissioned
    // run is judged as the last one — the quiet half of the 2026-09-20 failure.
    await refreshModelMenu();
    sendJson(res, 200, await configPayload());
    return true;
  }

  if (segments.length === 1 && segments[0] === 'active' && method === 'POST') {
    const body = await readJson(req);
    const id = typeof body.provider === 'string' ? body.provider : '';
    if (!providers().some((p) => p.id === id)) throw new HttpError(400, 'This build does not offer that provider.');
    await writeSetting(ACTIVE_PROVIDER, id);
    clearLLMClientCache();
    // A different service has certainly not been tested.
    await deleteSetting(LAST_PROBE);
    // Switching provider changes both what may be commissioned and what will
    // answer whatever is. Same reason as the config branch above.
    await refreshModelMenu();
    sendJson(res, 200, await configPayload());
    return true;
  }

  /*
   * THE MOST ONE RUN MAY SPEND.
   *
   * A subscription costs no money per call, so every run this service made on
   * 2026-09-19 reported "$0.00" while consuming 77% of a weekly allowance. The
   * ceiling exists because a meter nobody reads stops nothing. Zero clears it.
   */
  if (segments.length === 1 && segments[0] === 'ceiling' && method === 'POST') {
    const body = await readJson(req);
    const tokens = Number(body.tokens);
    if (!Number.isFinite(tokens) || tokens < 0) throw new HttpError(400, 'Give a number of tokens, or 0 for no ceiling.');
    if (tokens > 0) await writeSetting(RUN_TOKEN_CEILING, String(Math.floor(tokens)));
    else await deleteSetting(RUN_TOKEN_CEILING);
    await refreshModelMenu();
    sendJson(res, 200, await configPayload());
    return true;
  }

  /*
   * EVERYTHING THE ACTIVE PROVIDER SELLS, so the panel can build a menu from it.
   *
   * Deliberately NOT cached. It is a few hundred rows behind a sign-in, asked
   * only when somebody opens the picker, and a stale catalogue is worse than a
   * slow one: the whole point is to find the model that appeared last week.
   */
  if (segments.length === 1 && segments[0] === 'catalogue' && method === 'GET') {
    const { definition, config, problem } = await resolveProvider();
    if (problem) throw new HttpError(400, problem);
    if (!definition.catalogue) {
      throw new HttpError(400, `${definition.label} does not publish a list of models. Type the name in instead.`);
    }
    let entries;
    try {
      entries = await definition.catalogue(config);
    } catch (err) {
      // The same posture as the connection test: a provider that would not
      // answer is a fact about the provider, and the message it gave is the
      // useful half.
      throw new HttpError(502, `${definition.label} would not list its models: ${err instanceof Error ? err.message : String(err)}`);
    }
    sendJson(res, 200, { provider: definition.label, entries });
    return true;
  }

  /*
   * WHICH OF THEM THE ASSESSMENT PICKER OFFERS.
   *
   * An empty list is not an error, it is the reset: it clears the setting and
   * the built-in five come back. Note is stored with the choice so the submit
   * form never has to ask a provider what something is called.
   */
  if (segments.length === 1 && segments[0] === 'models' && method === 'POST') {
    const body = await readJson(req);
    const raw = body.models;
    if (!Array.isArray(raw)) throw new HttpError(400, 'Send a list of models.');
    if (raw.length > 60) throw new HttpError(400, 'That is more models than a dropdown can usefully hold. Pick the ones you will actually run.');

    const seen = new Set<string>();
    const models: OfferedModel[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') throw new HttpError(400, 'Each model has to be an object.');
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (!id) throw new HttpError(400, 'A model needs an id.');
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
        note: typeof row.note === 'string' ? row.note.slice(0, 400) : '',
        tier: typeof row.cost === 'number' || row.cost === null ? tierForCost(row.cost as number | null) : 'balanced',
      });
    }

    await saveOfferedModels(models);
    sendJson(res, 200, await configPayload());
    return true;
  }

  /*
   * A REAL CALL, AND A CHEAP ONE. There is no way to know a credential works
   * without using it, and "saved" is not the same claim as "reachable" — a
   * bridge on another machine, an expired key and a deployment that was renamed
   * all look identical until something asks. One token of output is the
   * smallest honest question.
   */
  if (segments.length === 1 && segments[0] === 'test' && method === 'POST') {
    const { definition, config, problem } = await resolveProvider();
    if (problem) throw new HttpError(400, problem);
    const started = Date.now();
    try {
      const client = definition.client(config);
      const model = definition.model(config) || definition.models(config)[0]?.id;
      if (!model) throw new Error('Nothing is configured to call.');
      const reply = await client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      });
      // RECORDED, because this is the one thing the task list cannot derive:
      // "saved" is not "reachable", and nothing else in the install can tell
      // the difference. Cleared wherever the configuration underneath it
      // changes, so it can never vouch for a setup that has since moved.
      await writeSetting(LAST_PROBE, `${definition.label} answered as ${reply.model ?? model} in ${Date.now() - started} ms.`);
      sendJson(res, 200, {
        ok: true,
        provider: definition.label,
        model: reply.model ?? model,
        ms: Date.now() - started,
      });
    } catch (err) {
      // 200 with `ok: false`: a failed connection test is a successful test.
      // The message is whatever the service said, which is the useful half.
      sendJson(res, 200, {
        ok: false,
        provider: definition.label,
        ms: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  return false;
}

/**
 * THE TASK LIST'S STATE.
 *
 * `status` is one of 'done' | 'todo' | 'optional'. The wizard renders them; it
 * does not decide them, because a client that decided what "configured" means
 * would be a second opinion about the thing the server already knows.
 */
async function setupPayload() {
  const active = await resolveProvider();
  const stored = await readAll().catch(() => ({} as Record<string, string>));
  const probe = stored[LAST_PROBE];
  const mode = await accessMode();

  const tasks = [
    {
      id: 'service',
      title: 'Choose which service answers',
      href: '/setup/service',
      status: 'done',
      detail: active.definition.label,
    },
    {
      id: 'connect',
      title: `Connect ${active.definition.label}`,
      href: `/setup/service/${active.definition.id}`,
      status: active.problem ? 'todo' : 'done',
      detail: active.problem ?? 'Configured.',
    },
    {
      id: 'test',
      title: 'Try the connection',
      href: '/setup/test',
      // The one status that cannot be derived. Saved is not reachable.
      status: probe ? 'done' : 'todo',
      detail: probe ?? 'Nothing has called a model yet.',
    },
    {
      id: 'access',
      title: 'Decide who can reach it',
      href: '/setup/access',
      status: 'done',
      detail: await accessSummary(),
    },
    {
      id: 'search',
      title: 'Decide about looking things up',
      href: '/setup/search',
      // Never 'todo': an install that does not search is correctly configured,
      // not incomplete. What matters is that the reader has been told which it
      // is, and `detail` is that sentence.
      status: 'optional',
      detail: searchPlan(Boolean(!active.problem && active.definition.grounded?.(active.config))).why,
    },
    {
      id: 'spend',
      title: 'Set what one run may spend',
      href: '/setup/spend',
      status: tokenCeiling() ? 'done' : 'optional',
      detail: tokenCeiling() ? `${tokenCeiling().toLocaleString()} tokens` : 'No ceiling.',
    },
    {
      id: 'egress',
      title: 'Hand your network team the list',
      href: '/setup/egress',
      status: 'optional',
      detail: 'Every host this install needs to reach.',
    },
  ];

  return {
    tasks,
    // "Ready" is the honest one: a provider that has actually answered. Not
    // "every field is filled in", which is what an install that cannot reach
    // its own endpoint also looks like.
    ready: !active.problem && Boolean(probe),
    provider: active.definition.label,
    egress: [...new Set(providers().flatMap((p) => p.egress))],
  };
}

async function configPayload() {
  const stored = await readAll().catch(() => ({} as Record<string, string>));
  const active = await resolveProvider();
  // Refreshed here so the model picker offers what the active provider serves —
  // otherwise `ingest.ts` reads a deployment name as unknown and the assessment
  // records "the configured default" for a run that named one.
  registerProviderModels(active.definition.models(active.config).map((m) => m.id));

  const chosen = await loadOfferedModels().catch(() => null);

  return {
    active: active.definition.id,
    activeProblem: active.problem,
    fromEnvironment: active.fromEnvironment,
    pinned: Boolean(process.env.POLICY_PROVIDER?.trim()),
    // Who may READ, as opposed to who may configure. Separate credential,
    // separate setting; see `$lib/server/reader-access`.
    access: await accessMode(),
    accessPinned: accessModeIsPinned(),
    accessSummary: await accessSummary(),
    // Whether the panel may change the admin password at all, or the
    // environment is deciding it. The field says so rather than accepting an
    // edit that will not take effect.
    adminPasswordPinned: adminPasswordIsPinned(),
    // Every host this install needs to reach, gathered from the providers
    // themselves so a firewall change can be written from one place.
    egress: [...new Set(providers().flatMap((p) => p.egress))],
    // WHERE RESEARCH LOOKS, and what a reader will be told about it. `why` is
    // the sentence, because "no sources were found" describes a search that
    // failed and "this install does not look things up" describes a decision.
    search: {
      engine: chosenEngine(),
      pinned: searchIsPinned(),
      tavilyKeySet: Boolean(tavilyKey()),
      domains: searchDomains().join(', '),
      ...searchPlan(Boolean(!active.problem && active.definition.grounded?.(active.config))),
    },
    // The assessment picker's menu, and whether anybody has touched it. The
    // panel needs to tell "these are the five this build ships with" from "these
    // are the five I chose", because the reset control only makes sense for one.
    menu: offeredModels(),
    menuChosen: Boolean(chosen),
    menuPinned: Boolean(process.env.POLICY_MODELS?.trim()),
    // 0 means no ceiling, which is the default.
    tokenCeiling: tokenCeiling(),
    builtIn: builtInModels(),
    canBrowse: Boolean(active.definition.catalogue),
    providers: providers().map((definition) => {
      const config: Record<string, string> = {};
      for (const field of definition.fields) {
        config[field.name] = stored[providerSettingKey(definition.id, field.name)] ?? '';
      }
      return {
        id: definition.id,
        label: definition.label,
        blurb: definition.blurb,
        fields: definition.fields,
        values: redact(definition, config),
        models: definition.models(config),
      };
    }),
  };
}
