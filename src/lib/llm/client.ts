/**
 * The model gateway.
 *
 * Upstream this routes between OpenRouter and a local Codex bridge, falls back
 * from one to the other on a credit outage, reads its key and its model defaults
 * from a settings table, and installs a usage capture that writes every call to
 * the site's cost ledger. None of that infrastructure exists here.
 *
 * What is left is what the pipeline actually asks for — `getLLMClient`, which
 * hands back a client and the model id to call it with. WHICH SERVICE ANSWERS is
 * now a configured thing rather than a compiled one: see
 * `$lib/llm/providers`, one module per service, and the admin panel that fills
 * them in.
 *
 * ENVIRONMENT BEATS THE STORE, ALWAYS. A key in `app.env` wins over anything the
 * panel holds, so a deployment managed by Ansible keeps doing what its files say
 * and nobody has to work out which of two sources is live. `resolveProvider`
 * reports which one is in force and the panel prints it.
 *
 * IT DOES NOT READ `ctx.provider`. That field belongs to the pipeline's own
 * `ModelContext` — a COPIED type — and records what an assessment was run on.
 * The service that answers is this module's business, and keeping the two
 * vocabularies apart is what lets the whole registry exist without a divergence.
 *
 * COST IS STILL RECORDED, just not centrally: the pipeline writes its own audit
 * to `policy_model_calls` through `server/provider.ts`, and it records the model
 * the API SAID answered — so a provider that serves a deployment rather than the
 * requested id is written down honestly.
 */
import type OpenAI from 'openai';
import { providerById, providers, REACHES_REAL_PROVIDERS, type ProviderConfig, type ProviderDefinition } from '$lib/llm/providers';
import { ACTIVE_PROVIDER, providerSettingKey, readAll } from '$lib/server/settings-store';
import type { ModelContext } from '$lib/server/models/types';
import { mapLegacyModelId } from '$lib/constants/default-models';
import { recordLLMCall } from '$lib/context/execution';
import { chargeRun } from '$lib/server/budget';

export type Resolved = {
  definition: ProviderDefinition;
  config: ProviderConfig;
  /** Which fields came from the environment rather than the store, so the panel can say so. */
  fromEnvironment: string[];
  /** Why this cannot be used, or null. */
  problem: string | null;
};

/**
 * The environment variable a field is allowed to come from.
 *
 * Only the ones a deployment plausibly manages. `OPENROUTER_API_KEY` is the name
 * every version of this service has used and every `.env.example` documents, so
 * it keeps working untouched; the others follow the same shape.
 */
const ENV_NAMES: Record<string, Record<string, string>> = {
  openrouter: { apiKey: 'OPENROUTER_API_KEY' },
  codex: { baseUrl: 'CODEX_BASE_URL', model: 'CODEX_MODEL', apiKey: 'CODEX_API_KEY' },
  azure: {
    endpoint: 'AZURE_FOUNDRY_ENDPOINT',
    deployment: 'AZURE_FOUNDRY_DEPLOYMENT',
    apiKey: 'AZURE_FOUNDRY_KEY',
    apiVersion: 'AZURE_FOUNDRY_API_VERSION',
    // The Entra fields. `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
    // `AZURE_CLIENT_SECRET` are the names Microsoft's own tooling sets, so a
    // container that already has them configured for anything else needs
    // nothing typed into the panel at all — which is the point of an
    // environment override.
    authMode: 'AZURE_AUTH_MODE',
    tenantId: 'AZURE_TENANT_ID',
    clientId: 'AZURE_CLIENT_ID',
    clientSecret: 'AZURE_CLIENT_SECRET',
    federatedTokenFile: 'AZURE_FEDERATED_TOKEN_FILE',
    authorityHost: 'AZURE_AUTHORITY_HOST',
  },
  // `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` are
  // what Databricks Apps injects for the app's own service principal, so an app
  // needs only the endpoint name set. `DATABRICKS_TOKEN` is the CLI's own name.
  databricks: {
    host: 'DATABRICKS_HOST',
    model: 'POLICY_DATABRICKS_ENDPOINT',
    authMode: 'POLICY_DATABRICKS_AUTH',
    clientId: 'DATABRICKS_CLIENT_ID',
    clientSecret: 'DATABRICKS_CLIENT_SECRET',
    token: 'DATABRICKS_TOKEN',
  },
};

let cached: { key: string; client: OpenAI } | undefined;

/** Dropped between tests, and whenever configuration changes underneath. */
export function clearLLMClientCache(): void {
  cached = undefined;
}

/**
 * Which service is in force, and whether it can be used.
 *
 * `POLICY_PROVIDER` pins it for a deployment; otherwise the panel's choice;
 * otherwise the first one this build offers, which is OpenRouter. An install
 * that had chosen a provider a later build no longer offers falls back with the
 * rest rather than failing — the panel shows what is active, so the change is
 * visible rather than mysterious.
 */
export async function resolveProvider(): Promise<Resolved> {
  const stored = await readAll().catch(() => ({} as Record<string, string>));
  const pinned = process.env.POLICY_PROVIDER?.trim();
  const definition =
    providerById(pinned) ?? providerById(stored[ACTIVE_PROVIDER]) ?? providers()[0];

  const config: ProviderConfig = {};
  const fromEnvironment: string[] = [];
  for (const field of definition.fields) {
    const envName = ENV_NAMES[definition.id]?.[field.name];
    const fromEnv = envName ? process.env[envName]?.trim() : undefined;
    if (fromEnv) {
      config[field.name] = fromEnv;
      fromEnvironment.push(field.name);
    } else {
      config[field.name] = stored[providerSettingKey(definition.id, field.name)] ?? '';
    }
  }

  return { definition, config, fromEnvironment, problem: definition.problem(config) };
}

/**
 * Can this build reach a model at all? Null when it can, otherwise a sentence.
 *
 * It exists so a missing credential is caught BEFORE an assessment is created
 * rather than two stages in. The first run of a fresh clone without a key used
 * to end in "failed." and a report file full of nothing, with the actual cause
 * buried in a stage's error column where the command line never showed it.
 */
export async function modelAccessProblem(): Promise<string | null> {
  // A FIXTURE BUILD HAS NO CREDENTIAL TO BE MISSING. The model is
  // `provider.fixture.ts` and `client()` throws by design, so refusing to start
  // is refusing on the grounds of a key that would change nothing — and it is
  // what broke `npm run assess:fixture`, the README's own "try it without a
  // key". See `providers/index.ts`.
  if (!REACHES_REAL_PROVIDERS) return null;
  const { definition, problem } = await resolveProvider();
  return problem ? `${definition.label}: ${problem}` : null;
}

/**
 * A client, and the model id to call it with.
 *
 * THE ACTIVE PROVIDER DECIDES THE MODEL where it serves only one. An Azure
 * deployment or a bridge answers with whatever is behind it whatever id is
 * asked for, so substituting here and letting the audit record what actually
 * replied is honest; pretending the request went to `anthropic/claude-sonnet-4.5`
 * because a workload default named it would not be.
 */
export async function getLLMClient(ctx: ModelContext): Promise<{ client: OpenAI; model: string }> {
  const { definition, config, problem } = await resolveProvider();
  if (problem) throw new Error(`${definition.label} is not usable: ${problem}`);

  // Keyed on the configuration, so editing a credential in the panel takes
  // effect on the next call rather than after a restart.
  const key = `${definition.id}:${JSON.stringify(config)}`;
  if (cached?.key !== key) cached = { key, client: instrument(definition.id, definition.client(config)) };

  const own = definition.model(config);
  return { client: cached.client, model: own || mapLegacyModelId(ctx.modelId) };
}

/**
 * COUNT WHAT EVERY CALL COSTS, or find out from the bill.
 *
 * Upstream installs a usage capture inside its own LLM client, and this fork
 * dropped it along with the cost ledger it fed — so `policy_model_calls.usage`
 * came back `[]` on every row. The pipeline was recording WHAT it called and
 * never HOW MUCH, which is survivable on a metered card and is not on a
 * subscription with a weekly allowance.
 *
 * It cost exactly that on 2026-09-19: a run made 385 calls carrying up to
 * ~910,000 characters of uncached context each, and the first anyone knew was
 * the subscription reporting 75% consumed for the week. Nothing on this side was
 * counting, so nothing on this side could warn.
 *
 * `recordLLMCall` is a no-op outside an engine-managed node, so wrapping here is
 * safe for every caller — the CLI, the admin panel's test button, a persona
 * enrichment — and only the pipeline's own calls are actually collected.
 *
 * EXPORTED SINCE PHASE 18, for the grounded search client. `grounded()` builds
 * its own client from the same credentials and it never passed through here, so
 * up to twenty-four research calls a run reached neither the ledger nor the
 * spend ceiling — a quarter of the traffic invisible to the thing that is meant
 * to stop a run that goes wrong.
 *
 * CACHED TOKENS ARE THE POINT, not a detail. `prompt_tokens_details.cached_tokens`
 * is the only honest way to tell whether the shared-context ordering is working;
 * without it "caching is on" is a claim about configuration rather than about
 * what happened.
 */
export function instrument(providerId: string, client: OpenAI): OpenAI {
  const completions = client.chat.completions;
  const create = completions.create.bind(completions);

  completions.create = (async (body: Parameters<typeof create>[0], options?: Parameters<typeof create>[1]) => {
    const result = await create(body, options);
    let charge = 0;
    try {
      // A streamed response has no `usage` to read here; the pipeline does not
      // stream, and a missing usage block must never break the call.
      const usage = (result as { usage?: Record<string, unknown> }).usage;
      if (usage) {
        const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const promptDetails = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
        const outputDetails = usage.completion_tokens_details as { reasoning_tokens?: unknown } | undefined;
        recordLLMCall({
          provider: providerId,
          model: String((result as { model?: unknown }).model ?? (body as { model?: unknown }).model ?? ''),
          tokensInput: num(usage.prompt_tokens),
          tokensOutput: num(usage.completion_tokens),
          cacheReadTokens: num(promptDetails?.cached_tokens),
          reasoningTokens: num(outputDetails?.reasoning_tokens),
          // A subscription bridge quotes no price, and inventing one would put a
          // fabricated number in the audit. Tokens are the truth we have.
          costUsd: null,
          priceSnapshot: null,
        });
        /*
         * AND CHARGE IT AGAINST THE RUN'S CEILING.
         *
         * Deliberately OUTSIDE the try/catch below. Recording usage must never
         * fail a call — but refusing to spend past a ceiling is the one thing
         * here that MUST be able to. A budget that gets swallowed by an error
         * handler is a budget that does not exist, which is what the whole of
         * 2026-09-19 demonstrated.
         */
        charge = (num(usage.prompt_tokens) ?? 0) + (num(usage.completion_tokens) ?? 0);
      }
    } catch {
      // Accounting must never be able to fail a model call.
    }
    if (charge) chargeRun(charge);
    return result;
  }) as typeof completions.create;

  return client;
}
