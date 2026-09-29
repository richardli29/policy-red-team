/**
 * Credentials, read from the environment.
 *
 * Upstream these come from a settings table with an encrypted-at-rest store and
 * a UI to edit them. A standalone tool has one user, who has a `.env`.
 */

import { tavilyKey } from '$lib/server/search';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Set it in the environment, or in app.yaml on Databricks Apps.`
    );
  }
  return value;
}

/** One OpenRouter key funds every model this build can reach. */
export function getOpenRouterApiKey(): string {
  return required('OPENROUTER_API_KEY');
}

/**
 * Tavily powers the targeted-research stage. It is OPTIONAL: an assessment
 * without it still runs, and the research stage records that it had no search
 * rather than failing the run.
 *
 * IT COMES FROM THE STORE AS WELL AS THE ENVIRONMENT NOW. `tavily.ts` is a
 * copied file and calls `getTavilyKey()` synchronously, so the value is held in
 * a module variable refreshed from `policy_settings` at the same three moments
 * everything else here is — see `$lib/server/search`. Before this the one
 * credential a reader is most likely to add second had no box to put it in, and
 * the setup journey could walk somebody through connecting a model and then not
 * ask about search at all.
 *
 * The ENVIRONMENT still wins, as everywhere else in this service.
 */
export function hasTavilyKey(): boolean {
  return Boolean(tavilyKey());
}

export function getTavilyKey(): string {
  const key = tavilyKey();
  if (!key) {
    throw new Error(
      'No Tavily key is configured. Set TAVILY_API_KEY, or put one in on the configuration page.',
    );
  }
  return key;
}
