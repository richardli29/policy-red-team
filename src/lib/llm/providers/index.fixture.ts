/**
 * A registry with no services behind it.
 *
 * The fixture build's guarantee is that the bundle CANNOT REACH A PROVIDER, and
 * `build.mjs` enforces it by asserting `openrouter.ai` does not appear in the
 * output. The real registry fails that assertion the moment it exists, because a
 * provider module is mostly the URL it calls — so this is the registry the
 * fixture build gets instead.
 *
 * IT IS NOT EMPTY. The admin panel is part of the service and the browser walk
 * has to exercise it: the shapes are all here, the fields are all here, saving
 * works and the configuration round-trips. What is missing is the only thing
 * that matters — `client()` throws rather than constructing anything, so a
 * connection test in a fixture build fails loudly and truthfully instead of
 * quietly costing money in a test run.
 *
 * The same argument as `client.fixture.ts`: redirect the module rather than
 * chase its importers, because the guarantee should not depend on anyone
 * remembering to add a file here.
 */
import type { CatalogueEntry, ProviderDefinition, ProviderId } from './types';

export type { ProviderDefinition, ProviderId, ProviderField, ProviderConfig, CatalogueEntry } from './types';

const unreachable = (label: string): never => {
  throw new Error(
    `${label} cannot be reached from this build. It was compiled with the fixture provider ` +
      `for testing; run the real build to make model calls.`,
  );
};

/**
 * Whether a field is on screen given what has been answered so far.
 *
 * The fixture has to agree with the real registry about this, not just about
 * the field list: a stub that demanded a client secret while the reader had
 * chosen key authentication would be a panel the walk could never complete, and
 * the walk is the only thing that drives this registry at all.
 */
const visible = (field: ProviderDefinition['fields'][number], config: Record<string, string>): boolean =>
  !field.showWhen || field.showWhen.is.includes(config[field.showWhen.field]?.trim() || defaultOf(field.showWhen.field));

/** A select's first option is its default when nothing is stored. Mirrors the real registry. */
function defaultOf(name: string): string {
  for (const definition of ALL) {
    const field = definition.fields.find((f) => f.name === name);
    if (field?.kind === 'select') return field.options?.[0]?.value ?? '';
  }
  return '';
}

function stub(
  id: ProviderId,
  label: string,
  blurb: string,
  egress: string[],
  fields: ProviderDefinition['fields'],
): ProviderDefinition {
  return {
    id,
    label,
    blurb,
    egress,
    fields,
    problem: (config) =>
      fields.every((f) => f.optional || !visible(f, config) || config[f.name]?.trim()) ? null : `Fill in ${label}.`,
    model: (config) => config.model?.trim() || config.deployment?.trim() || '',
    client: () => unreachable(label),
    /*
     * A CATALOGUE THAT REACHES NOTHING, so the browser walk can drive the model
     * picker without a key and without a network.
     *
     * Six rows, fixed, and one of them floating — the shapes the panel has to
     * render are a long id, a price, a missing price, and the `~` alias that
     * redirects to whatever is newest. A real call is what `client()` refuses;
     * listing a menu is not a call, and stubbing it here keeps the dialogue
     * under test rather than untested-because-untestable.
     */
    catalogue: async () => FIXTURE_CATALOGUE,
    models: (config) => {
      const own = config.model?.trim() || config.deployment?.trim();
      return own ? [{ id: own, name: own, note: 'Configured here.' }] : [];
    },
  };
}

const FIXTURE_CATALOGUE: CatalogueEntry[] = [
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Efficiency-optimised, one million tokens of context.', contextLength: 1_048_576, promptCost: 0.046, completionCost: 0.093, floating: false },
  { id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash Latest', description: 'Always redirects to the newest model in the DeepSeek Flash family.', contextLength: 1_048_576, promptCost: 0.13, completionCost: 0.52, floating: true },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', description: 'Strong at holding a long document in view.', contextLength: 200_000, promptCost: 3, completionCost: 15, floating: false },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Long context at low cost.', contextLength: 1_048_576, promptCost: 0.3, completionCost: 2.5, floating: false },
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', description: 'Open weights, good at structure.', contextLength: 131_072, promptCost: 0.09, completionCost: 0.45, floating: false },
  { id: 'local/no-price-quoted', name: 'A bridge model with no price', description: 'Bills against a subscription, so nothing is quoted per token.', contextLength: null, promptCost: null, completionCost: null, floating: false },
];

/**
 * THE FIELD LISTS ARE COPIED BY HAND, AND THEY HAVE TO BE.
 *
 * Importing them from the real modules would be better in every way except the
 * one that matters: `build.mjs` asserts that no provider endpoint string
 * survives in the fixture bundle, and the real Azure field carries
 * `my-resource.openai` + the Azure host as a placeholder. An import would drag
 * it in and fail the build — correctly, because the guarantee is about bytes
 * rather than intent.
 *
 * `fixture-parity.test.ts` is what keeps the two in step: names, secret and
 * optional flags, field kinds, select options and `showWhen` conditions must
 * all match. The prose the panel shows deliberately does not, for the reason
 * above.
 */
const ALL: ProviderDefinition[] = [
  stub('openrouter', 'OpenRouter', 'Per-token access to every model in the picker.', ['a per-token model service'], [
    { name: 'apiKey', label: 'API key', hint: 'From your OpenRouter account.', secret: true },
  ]),
  stub('codex', 'Codex bridge, or another OpenAI-compatible endpoint', 'Anything that speaks the OpenAI chat-completions API at a URL you control.', ['the base URL you configure below (nothing, if it is on this machine)'], [
    { name: 'baseUrl', label: 'Base URL', hint: 'Where the endpoint is.' },
    { name: 'model', label: 'Model name', hint: 'Exactly what the endpoint calls it.' },
    { name: 'apiKey', label: 'API key', hint: 'Optional.', secret: true, optional: true },
  ]),
  stub('azure', 'Azure AI Foundry', 'A model you have already provisioned in Azure.', ['your resource endpoint', 'the Entra sign-in host (app registration or workload identity only)'], [
    { name: 'endpoint', label: 'Endpoint', hint: 'The resource endpoint.' },
    { name: 'deployment', label: 'Deployment name', hint: 'What you called the deployment.' },
    {
      name: 'authMode',
      label: 'How to authenticate',
      hint: 'A resource with local authentication switched off has no key.',
      kind: 'select',
      options: [
        { value: 'key', text: 'An API key from the resource' },
        { value: 'entra-app', text: 'Microsoft Entra — app registration (client secret)' },
        { value: 'managed-identity', text: 'Microsoft Entra — managed identity of this machine' },
        { value: 'workload-identity', text: 'Microsoft Entra — workload identity (AKS federated token)' },
      ],
    },
    { name: 'apiKey', label: 'API key', hint: 'Either key from the resource.', secret: true, showWhen: { field: 'authMode', is: ['key'] } },
    { name: 'tenantId', label: 'Directory (tenant) ID', hint: 'The tenant the resource lives in.', showWhen: { field: 'authMode', is: ['entra-app', 'workload-identity'] } },
    { name: 'clientId', label: 'Application (client) ID', hint: 'Blank unless you need to name one identity of several.', optional: true, showWhen: { field: 'authMode', is: ['entra-app', 'managed-identity', 'workload-identity'] } },
    { name: 'clientSecret', label: 'Client secret', hint: 'From the app registration.', secret: true, showWhen: { field: 'authMode', is: ['entra-app'] } },
    { name: 'federatedTokenFile', label: 'Federated token file', hint: 'Blank to use the cluster’s own.', optional: true, showWhen: { field: 'authMode', is: ['workload-identity'] } },
    { name: 'authorityHost', label: 'Entra authority', hint: 'Blank unless this is a sovereign cloud.', optional: true, showWhen: { field: 'authMode', is: ['entra-app', 'workload-identity'] } },
    { name: 'apiVersion', label: 'API version', hint: 'Leave blank for the default.', optional: true },
  ]),
  stub('databricks', 'Databricks Model Serving', 'A model served in your Databricks workspace.', ['your Databricks workspace host (model serving, and its OAuth token endpoint)'], [
    { name: 'host', label: 'Workspace URL', hint: 'The address of the workspace.' },
    { name: 'model', label: 'Serving endpoint', hint: 'The endpoint name.' },
    {
      name: 'authMode',
      label: 'How to authenticate',
      hint: 'A deployment uses its service principal.',
      kind: 'select',
      options: [
        { value: 'service-principal', text: 'Service principal (OAuth) — what Databricks Apps provides' },
        { value: 'token', text: 'Personal access token' },
      ],
    },
    { name: 'clientId', label: 'Client ID', hint: 'The service principal’s application ID.', showWhen: { field: 'authMode', is: ['service-principal'] } },
    { name: 'clientSecret', label: 'Client secret', hint: 'An OAuth secret for that service principal.', secret: true, showWhen: { field: 'authMode', is: ['service-principal'] } },
    { name: 'token', label: 'Access token', hint: 'A personal access token.', secret: true, showWhen: { field: 'authMode', is: ['token'] } },
  ]),
];

/**
 * NOTHING HERE CAN REACH ANYTHING, so there is no credential to be missing.
 *
 * `problem()` above still reports an empty field, because the admin panel's
 * dialogue is part of what the walk exercises and a stub that always said
 * "ready" would stop testing it. But the CLI's pre-flight guard — "do not
 * create an assessment that cannot run" — asks a different question, and in
 * this build the honest answer is that a key would change nothing.
 *
 * See `index.ts` for the counterpart and the bug it fixes.
 */
export const REACHES_REAL_PROVIDERS = false;

export function providers(): ProviderDefinition[] {
  const allowed = process.env.POLICY_PROVIDERS?.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!allowed?.length) return ALL;
  const narrowed = ALL.filter((p) => allowed.includes(p.id));
  return narrowed.length ? narrowed : ALL;
}

export function providerById(id: string | null | undefined): ProviderDefinition | null {
  return providers().find((p) => p.id === id) ?? null;
}

export function isProviderId(id: string | null | undefined): id is ProviderId {
  return !!providerById(id);
}

export function redact(definition: ProviderDefinition, config: Record<string, string>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of definition.fields) {
    const value = config[field.name] ?? '';
    out[field.name] = field.secret ? Boolean(value.trim()) : value;
  }
  return out;
}
