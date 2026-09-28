import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';

/**
 * THE WIRE, AND WHO IS ALLOWED TO DECIDE WHEN A CALL ENDS.
 *
 * Two separate problems live here, and the second one was invisible until this
 * service was aimed at a network it does not own.
 *
 * ── 1. A WIRE THAT OUTLASTS THE DEADLINE ABOVE IT ────────────────────────────
 *
 * Node's built-in `fetch` is undici, and undici's `headersTimeout` and
 * `bodyTimeout` both default to 300 seconds. The pipeline allows a slow
 * provider's call 420 (`SLOW_PROVIDER_TIMEOUT_MS`), so the socket gave up two
 * minutes before the deadline did — and because the deadline had not fired,
 * `provider.ts` classified the result through its TRANSPORT branch and reported
 * "the configured model provider could not be reached". The bridge was fine
 * every time.
 *
 * Measured on the run of 2026-09-19: three of the first ten calls died at
 * exactly 300.7s, while the completed ones ran 197–261s.
 *
 * THE RULE THIS ENCODES: the transport must never be the thing that decides. A
 * call should end because the deadline the code states has passed, and for no
 * other reason — anything else is a limit nobody wrote down being enforced under
 * a misleading error message. So this is set well clear of 420s rather than
 * exactly at it.
 *
 * ── 2. IMPORTING THIS FILE USED TO UN-PROXY THE WHOLE PROCESS ────────────────
 *
 * This is the one that matters for a deployment inside somebody else's network.
 *
 * `undici` the npm package and the undici inside Node are two different copies,
 * but they agree on where the global dispatcher lives: a symbol in the global
 * registry. The package's `global.js` claims that slot with a plain `Agent` on
 * first import if nothing has claimed it yet — and Node's own `fetch` reads the
 * same slot. So merely importing this module, before any call was made,
 * replaced whatever proxy-aware dispatcher Node had been about to install with
 * one that talks straight to the origin.
 *
 * MEASURED, 2026-09-21, with `NODE_USE_ENV_PROXY=1` and an `HTTPS_PROXY`
 * pointing at a closed port:
 *
 *     plain node fetch            ECONNREFUSED   (the proxy was used: correct)
 *     after `import('undici')`    200 from the origin   (the proxy was skipped)
 *
 * Every provider is affected, not only the ones that spread
 * `longRunningTransport()` into their client — Tavily, the catalogue fetches
 * and the admin panel's connection test all go through `fetch`. In an estate
 * whose only route out is a proxy, that is the difference between a service
 * that works and one that reports every model as unreachable.
 *
 * So this module now claims the slot DELIBERATELY, with an `EnvHttpProxyAgent`,
 * which is undici's own reader of `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * (and their lowercase spellings). With none of those set it behaves exactly
 * like the `Agent` it replaces, so an install on the open internet sees no
 * change. `NODE_USE_ENV_PROXY` is not required and not consulted: this is the
 * process deciding for itself rather than asking to be told twice.
 *
 * A TLS-inspecting middlebox is the other half of the same estate and is NOT
 * handled here, because it cannot be: `NODE_EXTRA_CA_CERTS` is read by Node
 * before any of our code runs. `scripts/doctor.mjs` reports whether it is set,
 * and the README says to set it.
 */
// 720 s since 2026-09-24: Databricks gives a Claude request that was once cut
// off 64,000 tokens, about 580 s of writing, and its deadline is 660 s. The
// wire must outlast the deadline or it decides first and reads as an outage.
const LONG_CALL_MS = 720_000;

/**
 * One agent, module-scoped, because an Agent owns a connection pool. Building
 * one per client would open a fresh pool for every configuration change and
 * leave the old ones to be collected with their sockets still open.
 */
const longRunningAgent = new EnvHttpProxyAgent({
  headersTimeout: LONG_CALL_MS,
  bodyTimeout: LONG_CALL_MS,
});

/**
 * The dispatcher every OTHER call in the process uses — a catalogue listing, a
 * Tavily search, the connection test — at undici's ordinary timeouts.
 *
 * Installed at module load, which is the only moment early enough to matter:
 * the first `fetch` anywhere in the process latches whatever is in the slot.
 * `server/index.ts` and `cli.ts` both reach the provider registry before they
 * serve anything, so importing it there is enough.
 */
const environmentAgent = new EnvHttpProxyAgent();

setGlobalDispatcher(environmentAgent);

/** Whether a proxy is actually in force, for the boot report and the doctor. */
export function proxyInUse(): { https: string | null; http: string | null; noProxy: string | null } {
  const read = (...names: string[]) => {
    for (const name of names) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return null;
  };
  return {
    https: read('https_proxy', 'HTTPS_PROXY'),
    http: read('http_proxy', 'HTTP_PROXY'),
    noProxy: read('no_proxy', 'NO_PROXY'),
  };
}

/**
 * Constructor options that let a call run for as long as its caller allows.
 *
 * Spread into `new OpenAI({...})`. Only providers whose declared deadline can
 * exceed undici's 300-second default need it — but note that "OpenRouter's
 * deadline is 180 so it does not need this" stopped being true the moment a
 * provider could be configured that the pipeline's own timeout table cannot
 * name. `azure.ts` spreads it for exactly that reason.
 *
 * IT MUST BE undici's OWN `fetch`, NOT NODE'S. They are different copies of
 * undici, and a dispatcher built here is rejected by the built-in one — the SDK
 * even guesses at the cause: "This may be caused by passing an undici
 * dispatcher... that is incompatible". Passing the matching `fetch` alongside
 * the dispatcher is what makes the pair legal. That cost an attempt.
 */
export function longRunningTransport() {
  return {
    fetch: undiciFetch as unknown as typeof globalThis.fetch,
    fetchOptions: { dispatcher: longRunningAgent },
  };
}

/**
 * Exported only so a test can prove the slot was claimed by something that
 * reads the environment, rather than by the plain Agent that used to win.
 */
export const dispatcherKind = () => environmentAgent.constructor.name;
